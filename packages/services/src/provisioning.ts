/**
 * Provisioning orchestration.
 *
 * enqueueProvisioningJobs  grant ledger -> jobs. Deterministic idempotency
 *                          keys ("GRANT:ea:<id>") + ON CONFLICT DO NOTHING
 *                          make the sweep safe to run any number of times.
 * runProvisioningWorker    executes due jobs through registered connectors:
 *                          success completes the job AND advances the grant
 *                          (activate / complete revocation) in the same
 *                          transaction; failures back off exponentially and
 *                          exhaust into the manual queue; MANUAL-connector
 *                          jobs route straight to the manual queue.
 * confirmManualFulfillment human confirmation for manual jobs — attributed
 *                          and timestamped; that confirmation IS the
 *                          deprovisioning/provisioning evidence.
 *
 * Role assignments carry no jobs of their own: they activate when their
 * last derived entitlement grant activates, and their revocation completes
 * when the last derived grant is revoked or cancelled — target systems only
 * know about entitlements (working rule 9).
 */

import {
  InvariantViolation,
  type ProvisioningJobStatus,
  type ProvisioningJobType,
  type RevocationReason,
} from '@iam/domain';
import type pg from 'pg';
import {writeAuditEvent} from './audit.js';
import type {Connector, ConnectorRegistry} from './connectors.js';
import {assertPermission, type AuthzContext} from './context.js';
import {activateGrantTx, completeRevocationTx} from './grants.js';
import {NotFoundError} from './identities.js';
import {withTransaction} from './tx.js';

// ---------------------------------------------------------------------------
// Enqueue: grant ledger -> jobs
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  grantJobIds: string[];
  revokeJobIds: string[];
  /** Role assignments settled directly because they have no pending derived grants. */
  settledRoleAssignmentIds: string[];
}

export async function enqueueProvisioningJobs(
  pool: pg.Pool,
  ctx: AuthzContext,
): Promise<EnqueueResult> {
  assertPermission(ctx, 'provisioning:write');

  return withTransaction(pool, async (client) => {
    const grantJobs = await client.query(
      `INSERT INTO provisioning_jobs
         (job_type, application_id, entitlement_assignment_id, connector_type, idempotency_key, payload)
       SELECT 'GRANT', e.application_id, ea.id, a.connector_type, 'GRANT:ea:' || ea.id,
              jsonb_build_object(
                'identityId', ea.identity_id,
                'entitlementCode', e.code,
                'externalRef', e.external_ref,
                'application', a.name,
                'accountIdentifier', ia.account_identifier,
                'accountExternalRef', ia.external_ref)
       FROM entitlement_assignments ea
       JOIN entitlements e ON e.id = ea.entitlement_id
       JOIN applications a ON a.id = e.application_id
       LEFT JOIN identity_accounts ia
         ON ia.identity_id = ea.identity_id AND ia.application_id = e.application_id
       WHERE ea.status = 'PENDING_PROVISIONING'
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
    );
    const revokeJobs = await client.query(
      `INSERT INTO provisioning_jobs
         (job_type, application_id, entitlement_assignment_id, connector_type, idempotency_key, payload)
       SELECT 'REVOKE', e.application_id, ea.id, a.connector_type, 'REVOKE:ea:' || ea.id,
              jsonb_build_object(
                'identityId', ea.identity_id,
                'entitlementCode', e.code,
                'externalRef', e.external_ref,
                'application', a.name,
                'accountIdentifier', ia.account_identifier,
                'accountExternalRef', ia.external_ref)
       FROM entitlement_assignments ea
       JOIN entitlements e ON e.id = ea.entitlement_id
       JOIN applications a ON a.id = e.application_id
       LEFT JOIN identity_accounts ia
         ON ia.identity_id = ea.identity_id AND ia.application_id = e.application_id
       WHERE ea.status = 'PENDING_REVOCATION'
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
    );
    const created = [
      ...grantJobs.rows.map((r) => r.id as string),
      ...revokeJobs.rows.map((r) => r.id as string),
    ];
    for (const jobId of created) {
      await writeAuditEvent(client, ctx, {
        action: 'provisioning_job.queued',
        entityType: 'provisioning_job',
        entityId: jobId,
      });
    }

    // Role assignments whose derived grants are already settled (or that
    // expand to nothing) advance without jobs of their own.
    const settledRoleAssignmentIds = [
      ...(await settlePendingRoleAssignments(client, ctx)),
      ...(await settleRevokingRoleAssignments(client, ctx)),
    ];

    return {
      grantJobIds: grantJobs.rows.map((r) => r.id as string),
      revokeJobIds: revokeJobs.rows.map((r) => r.id as string),
      settledRoleAssignmentIds,
    };
  });
}

async function settlePendingRoleAssignments(
  client: pg.PoolClient,
  ctx: AuthzContext,
): Promise<string[]> {
  const {rows} = await client.query(
    `SELECT ra.id FROM role_assignments ra
     WHERE ra.status = 'PENDING_PROVISIONING'
       AND NOT EXISTS (
         SELECT 1 FROM entitlement_assignments ea
         WHERE ea.source_role_assignment_id = ra.id AND ea.status = 'PENDING_PROVISIONING')
     FOR UPDATE OF ra`,
  );
  for (const {id} of rows as {id: string}[]) {
    await activateGrantTx(client, ctx, 'role_assignments', id);
  }
  return rows.map((r) => r.id as string);
}

async function settleRevokingRoleAssignments(
  client: pg.PoolClient,
  ctx: AuthzContext,
): Promise<string[]> {
  const {rows} = await client.query(
    `SELECT ra.id, ra.revoked_reason FROM role_assignments ra
     WHERE ra.status = 'PENDING_REVOCATION'
       AND NOT EXISTS (
         SELECT 1 FROM entitlement_assignments ea
         WHERE ea.source_role_assignment_id = ra.id
           AND ea.status IN ('PENDING_PROVISIONING', 'ACTIVE', 'PENDING_REVOCATION'))
     FOR UPDATE OF ra`,
  );
  for (const row of rows as {id: string; revoked_reason: RevocationReason | null}[]) {
    await completeRevocationTx(
      client,
      ctx,
      'role_assignments',
      row.id,
      row.revoked_reason ?? 'MANUAL',
    );
  }
  return rows.map((r) => r.id as string);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface WorkerOptions {
  now?: Date;
  batchSize?: number;
  /** After this many failed attempts the job routes to the manual queue. */
  maxAttempts?: number;
  /** Base for exponential backoff: base * 2^attempts. */
  backoffBaseMs?: number;
}

export interface WorkerRunResult {
  completed: string[];
  failed: string[];
  manualRouted: string[];
}

export async function runProvisioningWorker(
  pool: pg.Pool,
  ctx: AuthzContext,
  registry: ConnectorRegistry,
  options: WorkerOptions = {},
): Promise<WorkerRunResult> {
  assertPermission(ctx, 'provisioning:write');
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 20;
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffBaseMs = options.backoffBaseMs ?? 60_000;

  const due = await pool.query(
    `SELECT id FROM provisioning_jobs
     WHERE status IN ('QUEUED', 'FAILED') AND scheduled_for <= $1
     ORDER BY scheduled_for LIMIT $2`,
    [now, batchSize],
  );

  const result: WorkerRunResult = {completed: [], failed: [], manualRouted: []};
  for (const {id} of due.rows as {id: string}[]) {
    const outcome = await withTransaction(pool, (client) =>
      processJob(client, ctx, registry, id, {now, maxAttempts, backoffBaseMs}),
    );
    if (outcome !== null) {
      result[outcome].push(id);
    }
  }
  return result;
}

async function processJob(
  client: pg.PoolClient,
  ctx: AuthzContext,
  registry: ConnectorRegistry,
  jobId: string,
  opts: {now: Date; maxAttempts: number; backoffBaseMs: number},
): Promise<keyof WorkerRunResult | null> {
  const {rows} = await client.query(
    `SELECT * FROM provisioning_jobs WHERE id = $1 FOR UPDATE SKIP LOCKED`,
    [jobId],
  );
  if (rows.length === 0) {
    return null; // another worker holds it
  }
  const job = rows[0] as Record<string, unknown>;
  const status = job['status'] as ProvisioningJobStatus;
  if (status !== 'QUEUED' && status !== 'FAILED') {
    return null; // settled since selection
  }

  // Manual-fulfillment applications: route to the human queue.
  if (job['connector_type'] === 'MANUAL') {
    await client.query(
      `UPDATE provisioning_jobs SET status = 'MANUAL_PENDING' WHERE id = $1`,
      [jobId],
    );
    await writeAuditEvent(client, ctx, {
      action: 'provisioning_job.manual_routed',
      entityType: 'provisioning_job',
      entityId: jobId,
      afterState: {reason: 'manual fulfillment application'},
    });
    return 'manualRouted';
  }

  const connector = registry.get(job['connector_type'] as Connector['type']);
  if (connector === undefined) {
    return await failJob(client, ctx, job, `no connector registered for ${job['connector_type']}`, opts);
  }

  await client.query(
    `UPDATE provisioning_jobs
     SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1`,
    [jobId],
  );

  let outcome: Awaited<ReturnType<Connector['execute']>>;
  try {
    outcome = await connector.execute({
      id: jobId,
      jobType: job['job_type'] as ProvisioningJobType,
      applicationId: job['application_id'] as string,
      payload: job['payload'] as Record<string, unknown>,
    });
  } catch (err) {
    outcome = {ok: false, error: err instanceof Error ? err.message : String(err), retryable: true};
  }

  if (!outcome.ok) {
    return await failJob(client, ctx, job, outcome.error, opts, outcome.retryable);
  }

  await client.query(
    `UPDATE provisioning_jobs SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
    [jobId],
  );
  await writeAuditEvent(client, ctx, {
    action: 'provisioning_job.completed',
    entityType: 'provisioning_job',
    entityId: jobId,
  });
  await applyJobCompletion(client, ctx, job);
  return 'completed';
}

async function failJob(
  client: pg.PoolClient,
  ctx: AuthzContext,
  job: Record<string, unknown>,
  error: string,
  opts: {now: Date; maxAttempts: number; backoffBaseMs: number},
  retryable = true,
): Promise<'failed' | 'manualRouted'> {
  const jobId = job['id'] as string;
  const attempts = (job['attempt_count'] as number) + 1;
  const exhausted = !retryable || attempts >= opts.maxAttempts;

  if (exhausted) {
    await client.query(
      `UPDATE provisioning_jobs
       SET status = 'MANUAL_PENDING', attempt_count = $2, last_error = $3 WHERE id = $1`,
      [jobId, attempts, error],
    );
    await writeAuditEvent(client, ctx, {
      action: 'provisioning_job.manual_routed',
      entityType: 'provisioning_job',
      entityId: jobId,
      afterState: {reason: retryable ? 'retries exhausted' : 'non-retryable failure', attempts, error},
    });
    return 'manualRouted';
  }

  const backoffMs = opts.backoffBaseMs * 2 ** attempts;
  await client.query(
    `UPDATE provisioning_jobs
     SET status = 'FAILED', attempt_count = $2, last_error = $3, scheduled_for = $4
     WHERE id = $1`,
    [jobId, attempts, error, new Date(opts.now.getTime() + backoffMs)],
  );
  await writeAuditEvent(client, ctx, {
    action: 'provisioning_job.failed',
    entityType: 'provisioning_job',
    entityId: jobId,
    afterState: {attempts, error, retryAt: new Date(opts.now.getTime() + backoffMs)},
  });
  return 'failed';
}

/**
 * Job completion drives the grant ledger: GRANT activates the grant,
 * REVOKE completes the revocation — and the parent role assignment is
 * settled when its last derived grant settles.
 */
async function applyJobCompletion(
  client: pg.PoolClient,
  ctx: AuthzContext,
  job: Record<string, unknown>,
): Promise<void> {
  const eaId = job['entitlement_assignment_id'] as string | null;
  const raId = job['role_assignment_id'] as string | null;
  const jobType = job['job_type'] as ProvisioningJobType;

  if (eaId !== null) {
    const ea = await client.query(
      'SELECT source_role_assignment_id, revoked_reason FROM entitlement_assignments WHERE id = $1',
      [eaId],
    );
    const sourceRa = ea.rows[0]?.source_role_assignment_id as string | null;
    if (jobType === 'GRANT') {
      await activateGrantTx(client, ctx, 'entitlement_assignments', eaId);
      if (sourceRa !== null) {
        await maybeSettleRoleAssignment(client, ctx, sourceRa);
      }
    } else if (jobType === 'REVOKE') {
      const reason = (ea.rows[0]?.revoked_reason as RevocationReason | null) ?? 'MANUAL';
      await completeRevocationTx(client, ctx, 'entitlement_assignments', eaId, reason);
      if (sourceRa !== null) {
        await maybeSettleRoleAssignment(client, ctx, sourceRa);
      }
    }
  } else if (raId !== null) {
    if (jobType === 'GRANT') {
      await activateGrantTx(client, ctx, 'role_assignments', raId);
    } else if (jobType === 'REVOKE') {
      await completeRevocationTx(client, ctx, 'role_assignments', raId, 'MANUAL');
    }
  }
  // identity_account jobs (CREATE/DISABLE/ENABLE_ACCOUNT) update the account
  // row via connectors in a later phase; no grant transition here.
}

async function maybeSettleRoleAssignment(
  client: pg.PoolClient,
  ctx: AuthzContext,
  roleAssignmentId: string,
): Promise<void> {
  const {rows} = await client.query(
    `SELECT ra.status, ra.revoked_reason,
            (SELECT count(*)::int FROM entitlement_assignments ea
             WHERE ea.source_role_assignment_id = ra.id
               AND ea.status = 'PENDING_PROVISIONING') AS pending_grants,
            (SELECT count(*)::int FROM entitlement_assignments ea
             WHERE ea.source_role_assignment_id = ra.id
               AND ea.status IN ('PENDING_PROVISIONING', 'ACTIVE', 'PENDING_REVOCATION')) AS unsettled
     FROM role_assignments ra WHERE ra.id = $1 FOR UPDATE OF ra`,
    [roleAssignmentId],
  );
  if (rows.length === 0) {
    return;
  }
  const ra = rows[0] as {
    status: string;
    revoked_reason: RevocationReason | null;
    pending_grants: number;
    unsettled: number;
  };
  if (ra.status === 'PENDING_PROVISIONING' && ra.pending_grants === 0) {
    await activateGrantTx(client, ctx, 'role_assignments', roleAssignmentId);
  } else if (ra.status === 'PENDING_REVOCATION' && ra.unsettled === 0) {
    await completeRevocationTx(
      client,
      ctx,
      'role_assignments',
      roleAssignmentId,
      ra.revoked_reason ?? 'MANUAL',
    );
  }
}

// ---------------------------------------------------------------------------
// Manual fulfillment queue
// ---------------------------------------------------------------------------

export async function listManualQueue(
  pool: pg.Pool,
  ctx: AuthzContext,
  applicationId?: string,
): Promise<Array<Record<string, unknown>>> {
  assertPermission(ctx, 'provisioning:read');
  const where = applicationId !== undefined ? 'AND application_id = $1' : '';
  const params = applicationId !== undefined ? [applicationId] : [];
  const {rows} = await pool.query(
    `SELECT * FROM provisioning_jobs WHERE status = 'MANUAL_PENDING' ${where} ORDER BY created_at`,
    params,
  );
  return rows as Array<Record<string, unknown>>;
}

/**
 * A human (app admin) confirms that the manual step was actually performed
 * in the target system. The attributed, timestamped confirmation is the
 * fulfillment evidence, and it advances the grant exactly like an automated
 * completion.
 */
export async function confirmManualFulfillment(
  pool: pg.Pool,
  ctx: AuthzContext,
  jobId: string,
): Promise<void> {
  assertPermission(ctx, 'provisioning:confirm');
  if (ctx.actorIdentityId === null) {
    throw new InvariantViolation(
      'HUMAN_ACTOR_REQUIRED',
      'manual fulfillment must be confirmed by a person',
    );
  }

  await withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      'SELECT * FROM provisioning_jobs WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('provisioning_job', jobId);
    }
    const job = rows[0] as Record<string, unknown>;
    if (job['status'] !== 'MANUAL_PENDING') {
      throw new InvariantViolation(
        'JOB_NOT_MANUAL_PENDING',
        `job is ${String(job['status'])}, not awaiting manual fulfillment`,
      );
    }
    await client.query(
      `UPDATE provisioning_jobs
       SET status = 'MANUAL_CONFIRMED', manual_confirmed_by_identity_id = $2,
           manual_confirmed_at = now(), completed_at = now()
       WHERE id = $1`,
      [jobId, ctx.actorIdentityId],
    );
    await writeAuditEvent(client, ctx, {
      action: 'provisioning_job.manual_confirmed',
      entityType: 'provisioning_job',
      entityId: jobId,
      afterState: {confirmedBy: ctx.actorIdentityId},
    });
    await applyJobCompletion(client, ctx, job);
  });
}

/** Cancels a job that has not completed (e.g. its grant was cancelled). */
export async function cancelProvisioningJob(
  pool: pg.Pool,
  ctx: AuthzContext,
  jobId: string,
  reason: string,
): Promise<void> {
  assertPermission(ctx, 'provisioning:write');

  await withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `SELECT status FROM provisioning_jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('provisioning_job', jobId);
    }
    const status = rows[0].status as ProvisioningJobStatus;
    if (!['QUEUED', 'FAILED', 'MANUAL_PENDING'].includes(status)) {
      throw new InvariantViolation(
        'JOB_NOT_CANCELLABLE',
        `job is ${status} and cannot be cancelled`,
      );
    }
    await client.query(
      `UPDATE provisioning_jobs SET status = 'CANCELLED', last_error = $2 WHERE id = $1`,
      [jobId, reason],
    );
    await writeAuditEvent(client, ctx, {
      action: 'provisioning_job.cancelled',
      entityType: 'provisioning_job',
      entityId: jobId,
      afterState: {reason},
    });
  });
}
