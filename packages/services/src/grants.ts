/**
 * Grant ledger service — the access model core.
 *
 * - Business roles are assigned to identities and EXPAND into ROLE_DERIVED
 *   technical entitlement grants (working rule 9: the two never mix).
 * - TEMPORARY access (role or entitlement) always carries an expiry
 *   (working rule 8; double-enforced by DB CHECKs).
 * - EXCEPTION access is direct entitlement access outside any role: it
 *   requires a justification, a four-eyes approver, an expiry, and creates
 *   a policy_exceptions governance record.
 * - Revocation is two-phase (request -> complete) because completion is
 *   evidence that deprovisioning actually happened; the provisioning
 *   orchestrator (next phase) drives completion. The expiry sweep uses the
 *   same path with reason EXPIRY.
 */

import {
  assertEntitlementAssignmentExpiry,
  assertEntitlementAssignmentSource,
  assertNoSelfApproval,
  assertRoleAssignmentExpiry,
  assertTransition,
  grantLifecycle,
  InvariantViolation,
  type EntitlementAssignment,
  type EntitlementAssignmentType,
  type GrantStatus,
  type PolicyException,
  type RevocationReason,
  type RoleAssignment,
  type RoleAssignmentType,
} from '@iam/domain';
import type pg from 'pg';
import {writeAuditEvent} from './audit.js';
import {assertPermission, type AuthzContext} from './context.js';
import {NotFoundError} from './identities.js';
import {withTransaction} from './tx.js';

function mapRoleAssignment(row: Record<string, unknown>): RoleAssignment {
  return {
    id: row['id'] as string,
    identityId: row['identity_id'] as string,
    roleId: row['role_id'] as string,
    assignmentType: row['assignment_type'] as RoleAssignmentType,
    grantedViaRequestId: row['granted_via_request_id'] as string | null,
    grantedByIdentityId: row['granted_by_identity_id'] as string | null,
    startsAt: row['starts_at'] as Date,
    expiresAt: row['expires_at'] as Date | null,
    status: row['status'] as GrantStatus,
    revokedReason: row['revoked_reason'] as RevocationReason | null,
    revokedAt: row['revoked_at'] as Date | null,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

function mapEntitlementAssignment(row: Record<string, unknown>): EntitlementAssignment {
  return {
    id: row['id'] as string,
    identityId: row['identity_id'] as string,
    entitlementId: row['entitlement_id'] as string,
    assignmentType: row['assignment_type'] as EntitlementAssignmentType,
    sourceRoleAssignmentId: row['source_role_assignment_id'] as string | null,
    grantedViaRequestId: row['granted_via_request_id'] as string | null,
    grantedByIdentityId: row['granted_by_identity_id'] as string | null,
    startsAt: row['starts_at'] as Date,
    expiresAt: row['expires_at'] as Date | null,
    status: row['status'] as GrantStatus,
    revokedReason: row['revoked_reason'] as RevocationReason | null,
    revokedAt: row['revoked_at'] as Date | null,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

async function assertIdentityCanReceiveAccess(
  client: pg.ClientBase,
  identityId: string,
): Promise<void> {
  const {rows} = await client.query('SELECT status FROM identities WHERE id = $1', [identityId]);
  if (rows.length === 0) {
    throw new NotFoundError('identity', identityId);
  }
  const status = rows[0].status as string;
  // Least privilege: no new access for suspended/leaving/terminated people.
  // PENDING is allowed so joiner birthright provisioning can run day-0 ready.
  if (status !== 'ACTIVE' && status !== 'PENDING') {
    throw new InvariantViolation(
      'IDENTITY_NOT_GRANTABLE',
      `identity ${identityId} has status ${status} and cannot receive new access`,
    );
  }
}

// ---------------------------------------------------------------------------
// Role assignment (with expansion into technical grants)
// ---------------------------------------------------------------------------

export interface AssignRoleInput {
  identityId: string;
  roleId: string;
  assignmentType: RoleAssignmentType;
  /** Mandatory for TEMPORARY assignments. */
  expiresAt?: Date | null;
  grantedViaRequestId?: string | null;
}

export interface AssignRoleResult {
  roleAssignment: RoleAssignment;
  /** ROLE_DERIVED grants created by expanding the role's entitlements. */
  entitlementAssignments: EntitlementAssignment[];
  /** Entitlements skipped because the identity already holds a live grant. */
  skippedEntitlementIds: string[];
}

export async function assignRoleToIdentity(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: AssignRoleInput,
): Promise<AssignRoleResult> {
  assertPermission(ctx, 'grant:write');
  return withTransaction(pool, (client) => assignRoleTx(client, ctx, input));
}

/**
 * Transaction-level variant used by the request-fulfillment pipeline, which
 * must grant inside the approval transaction. Callers are responsible for
 * authorization (either grant:write or an approved access request).
 */
export async function assignRoleTx(
  client: pg.PoolClient,
  ctx: AuthzContext,
  input: AssignRoleInput,
): Promise<AssignRoleResult> {
  const expiresAt = input.expiresAt ?? null;
  assertRoleAssignmentExpiry(input.assignmentType, {
    expiresAt,
    startsAt: new Date(),
    now: new Date(),
  });

  {
    await assertIdentityCanReceiveAccess(client, input.identityId);

    const role = await client.query('SELECT status FROM business_roles WHERE id = $1', [
      input.roleId,
    ]);
    if (role.rows.length === 0) {
      throw new NotFoundError('business_role', input.roleId);
    }
    if (role.rows[0].status !== 'ACTIVE') {
      throw new InvariantViolation('ROLE_DISABLED', 'disabled roles cannot be assigned');
    }

    const ra = await client.query(
      `INSERT INTO role_assignments
         (identity_id, role_id, assignment_type, granted_via_request_id,
          granted_by_identity_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.identityId,
        input.roleId,
        input.assignmentType,
        input.grantedViaRequestId ?? null,
        ctx.actorIdentityId,
        expiresAt,
      ],
    );
    const roleAssignment = mapRoleAssignment(ra.rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'grant.created',
      entityType: 'role_assignment',
      entityId: roleAssignment.id,
      afterState: roleAssignment,
    });

    // Expand: one ROLE_DERIVED technical grant per mapped entitlement,
    // inheriting the role assignment's expiry. Entitlements the identity
    // already holds live (from another role or a direct grant) are skipped —
    // the partial unique index arbitrates atomically via ON CONFLICT.
    const mapped = await client.query(
      'SELECT entitlement_id FROM role_entitlements WHERE role_id = $1',
      [input.roleId],
    );
    const entitlementAssignments: EntitlementAssignment[] = [];
    const skippedEntitlementIds: string[] = [];
    for (const {entitlement_id} of mapped.rows as {entitlement_id: string}[]) {
      const ea = await client.query(
        `INSERT INTO entitlement_assignments
           (identity_id, entitlement_id, assignment_type, source_role_assignment_id,
            granted_via_request_id, granted_by_identity_id, expires_at)
         VALUES ($1, $2, 'ROLE_DERIVED', $3, $4, $5, $6)
         ON CONFLICT (identity_id, entitlement_id)
           WHERE status IN ('PENDING_PROVISIONING', 'ACTIVE', 'PENDING_REVOCATION')
           DO NOTHING
         RETURNING *`,
        [
          input.identityId,
          entitlement_id,
          roleAssignment.id,
          input.grantedViaRequestId ?? null,
          ctx.actorIdentityId,
          expiresAt,
        ],
      );
      if (ea.rows.length === 0) {
        skippedEntitlementIds.push(entitlement_id);
        continue;
      }
      const grant = mapEntitlementAssignment(ea.rows[0] as Record<string, unknown>);
      entitlementAssignments.push(grant);
      await writeAuditEvent(client, ctx, {
        action: 'grant.created',
        entityType: 'entitlement_assignment',
        entityId: grant.id,
        afterState: grant,
      });
    }

    return {roleAssignment, entitlementAssignments, skippedEntitlementIds};
  }
}

// ---------------------------------------------------------------------------
// Direct access: temporary and exception grants
// ---------------------------------------------------------------------------

export interface GrantTemporaryAccessInput {
  identityId: string;
  entitlementId: string;
  /** Mandatory: temporary access always expires. */
  expiresAt: Date;
  grantedViaRequestId?: string | null;
}

export async function grantTemporaryAccess(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: GrantTemporaryAccessInput,
): Promise<EntitlementAssignment> {
  assertPermission(ctx, 'grant:write');
  return withTransaction(pool, (client) =>
    insertDirectGrant(client, ctx, {...input, assignmentType: 'TEMPORARY'}),
  );
}

export interface GrantExceptionInput {
  identityId: string;
  entitlementId: string;
  justification: string;
  /** Security approver; must not be the grantee (four-eyes). */
  approvedByIdentityId: string;
  /** Mandatory: exceptions always expire. */
  expiresAt: Date;
  exceptionType?: PolicyException['exceptionType'];
  reviewBefore?: Date | null;
  grantedViaRequestId?: string | null;
}

export interface GrantExceptionResult {
  assignment: EntitlementAssignment;
  policyExceptionId: string;
}

export async function grantExceptionAccess(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: GrantExceptionInput,
): Promise<GrantExceptionResult> {
  assertPermission(ctx, 'grant:write');
  return withTransaction(pool, (client) => grantExceptionTx(client, ctx, input));
}

/** Transaction-level variant used by the request-fulfillment pipeline. */
export async function grantExceptionTx(
  client: pg.PoolClient,
  ctx: AuthzContext,
  input: GrantExceptionInput,
): Promise<GrantExceptionResult> {
  if (input.justification.trim().length === 0) {
    throw new InvariantViolation(
      'JUSTIFICATION_REQUIRED',
      'exception access requires a written justification',
    );
  }
  assertNoSelfApproval(input.approvedByIdentityId, input.identityId);

  {
    const assignment = await insertDirectGrant(client, ctx, {
      identityId: input.identityId,
      entitlementId: input.entitlementId,
      expiresAt: input.expiresAt,
      grantedViaRequestId: input.grantedViaRequestId ?? null,
      assignmentType: 'EXCEPTION',
    });
    const pe = await client.query(
      `INSERT INTO policy_exceptions
         (entitlement_assignment_id, exception_type, justification,
          approved_by_identity_id, expires_at, review_before)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        assignment.id,
        input.exceptionType ?? 'DIRECT_ACCESS',
        input.justification,
        input.approvedByIdentityId,
        input.expiresAt,
        input.reviewBefore ?? null,
      ],
    );
    const policyExceptionId = (pe.rows[0] as {id: string}).id;
    await writeAuditEvent(client, ctx, {
      action: 'policy_exception.created',
      entityType: 'policy_exception',
      entityId: policyExceptionId,
      afterState: {
        entitlementAssignmentId: assignment.id,
        justification: input.justification,
        approvedByIdentityId: input.approvedByIdentityId,
        expiresAt: input.expiresAt,
      },
    });
    return {assignment, policyExceptionId};
  }
}

interface DirectGrantInput {
  identityId: string;
  entitlementId: string;
  assignmentType: 'TEMPORARY' | 'EXCEPTION';
  expiresAt: Date;
  grantedViaRequestId?: string | null;
}

async function insertDirectGrant(
  client: pg.PoolClient,
  ctx: AuthzContext,
  input: DirectGrantInput,
): Promise<EntitlementAssignment> {
  const now = new Date();
  assertEntitlementAssignmentExpiry(input.assignmentType, {
    expiresAt: input.expiresAt,
    startsAt: now,
    now,
  });
  assertEntitlementAssignmentSource(input.assignmentType, null);
  await assertIdentityCanReceiveAccess(client, input.identityId);

  const entitlement = await client.query('SELECT status FROM entitlements WHERE id = $1', [
    input.entitlementId,
  ]);
  if (entitlement.rows.length === 0) {
    throw new NotFoundError('entitlement', input.entitlementId);
  }
  if (entitlement.rows[0].status === 'DEPRECATED') {
    throw new InvariantViolation(
      'ENTITLEMENT_DEPRECATED',
      'deprecated entitlements cannot be granted',
    );
  }

  const {rows} = await client.query(
    `INSERT INTO entitlement_assignments
       (identity_id, entitlement_id, assignment_type, granted_via_request_id,
        granted_by_identity_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      input.identityId,
      input.entitlementId,
      input.assignmentType,
      input.grantedViaRequestId ?? null,
      ctx.actorIdentityId,
      input.expiresAt,
    ],
  );
  const grant = mapEntitlementAssignment(rows[0] as Record<string, unknown>);
  await writeAuditEvent(client, ctx, {
    action: 'grant.created',
    entityType: 'entitlement_assignment',
    entityId: grant.id,
    afterState: grant,
  });
  return grant;
}

// ---------------------------------------------------------------------------
// Grant lifecycle: activation, two-phase revocation
// ---------------------------------------------------------------------------

type GrantTable = 'role_assignments' | 'entitlement_assignments';

async function transitionGrant(
  client: pg.PoolClient,
  ctx: AuthzContext,
  table: GrantTable,
  grantId: string,
  to: GrantStatus,
  extra: {revokedReason?: RevocationReason} = {},
): Promise<Record<string, unknown>> {
  const current = await client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [grantId]);
  if (current.rows.length === 0) {
    throw new NotFoundError(table, grantId);
  }
  const from = current.rows[0].status as GrantStatus;
  assertTransition(grantLifecycle, from, to);

  const isRevoked = to === 'REVOKED';
  const {rows} = await client.query(
    `UPDATE ${table}
     SET status = $2,
         revoked_reason = COALESCE($3, revoked_reason),
         revoked_at = CASE WHEN $4 THEN now() ELSE revoked_at END
     WHERE id = $1 RETURNING *`,
    [grantId, to, extra.revokedReason ?? null, isRevoked],
  );

  const action =
    to === 'ACTIVE'
      ? 'grant.activated'
      : to === 'PENDING_REVOCATION'
        ? 'grant.revocation_requested'
        : to === 'REVOKED'
          ? extra.revokedReason === 'EXPIRY'
            ? 'grant.expired'
            : 'grant.revoked'
          : 'grant.cancelled';
  await writeAuditEvent(client, ctx, {
    action,
    entityType: table === 'role_assignments' ? 'role_assignment' : 'entitlement_assignment',
    entityId: grantId,
    beforeState: {status: from},
    afterState: {status: to, ...(extra.revokedReason ? {reason: extra.revokedReason} : {})},
  });
  return rows[0] as Record<string, unknown>;
}

/** Called by the provisioning orchestrator when a GRANT job completes. */
export async function activateGrant(
  pool: pg.Pool,
  ctx: AuthzContext,
  table: GrantTable,
  grantId: string,
): Promise<void> {
  assertPermission(ctx, 'grant:write');
  await withTransaction(pool, (client) => transitionGrant(client, ctx, table, grantId, 'ACTIVE'));
}

export interface RevocationResult {
  /** Grants moved to PENDING_REVOCATION (were ACTIVE; connectors must deprovision). */
  pendingRevocation: string[];
  /** Grants cancelled outright (were still PENDING_PROVISIONING). */
  cancelled: string[];
}

/**
 * Requests revocation of an entitlement grant. ACTIVE grants become
 * PENDING_REVOCATION (deprovisioning jobs complete them); grants not yet
 * provisioned are cancelled immediately.
 */
export async function requestEntitlementRevocation(
  pool: pg.Pool,
  ctx: AuthzContext,
  grantId: string,
  reason: RevocationReason,
): Promise<RevocationResult> {
  assertPermission(ctx, 'grant:write');
  return withTransaction(pool, (client) =>
    requestEntitlementRevocationTx(client, ctx, grantId, reason),
  );
}

async function requestEntitlementRevocationTx(
  client: pg.PoolClient,
  ctx: AuthzContext,
  grantId: string,
  reason: RevocationReason,
): Promise<RevocationResult> {
  const {rows} = await client.query(
    'SELECT status FROM entitlement_assignments WHERE id = $1 FOR UPDATE',
    [grantId],
  );
  if (rows.length === 0) {
    throw new NotFoundError('entitlement_assignments', grantId);
  }
  const status = rows[0].status as GrantStatus;
  if (status === 'PENDING_PROVISIONING') {
    await transitionGrant(client, ctx, 'entitlement_assignments', grantId, 'CANCELLED', {
      revokedReason: reason,
    });
    return {pendingRevocation: [], cancelled: [grantId]};
  }
  await transitionGrant(client, ctx, 'entitlement_assignments', grantId, 'PENDING_REVOCATION', {
    revokedReason: reason,
  });
  return {pendingRevocation: [grantId], cancelled: []};
}

/** Called by the provisioning orchestrator when a REVOKE job completes. */
export async function completeEntitlementRevocation(
  pool: pg.Pool,
  ctx: AuthzContext,
  grantId: string,
  reason: RevocationReason,
): Promise<void> {
  assertPermission(ctx, 'grant:write');
  await withTransaction(pool, (client) =>
    transitionGrant(client, ctx, 'entitlement_assignments', grantId, 'REVOKED', {
      revokedReason: reason,
    }),
  );
}

/**
 * Requests revocation of a role assignment AND cascades to all ROLE_DERIVED
 * entitlement grants that came from it — removing a role always removes the
 * access it carried.
 */
export async function requestRoleRevocation(
  pool: pg.Pool,
  ctx: AuthzContext,
  roleAssignmentId: string,
  reason: RevocationReason,
): Promise<RevocationResult> {
  assertPermission(ctx, 'grant:write');

  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      'SELECT status FROM role_assignments WHERE id = $1 FOR UPDATE',
      [roleAssignmentId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('role_assignments', roleAssignmentId);
    }
    const status = rows[0].status as GrantStatus;
    const to = status === 'PENDING_PROVISIONING' ? 'CANCELLED' : 'PENDING_REVOCATION';
    await transitionGrant(client, ctx, 'role_assignments', roleAssignmentId, to, {
      revokedReason: reason,
    });

    const result: RevocationResult =
      to === 'CANCELLED'
        ? {pendingRevocation: [], cancelled: [roleAssignmentId]}
        : {pendingRevocation: [roleAssignmentId], cancelled: []};

    const derived = await client.query(
      `SELECT id FROM entitlement_assignments
       WHERE source_role_assignment_id = $1
         AND status IN ('PENDING_PROVISIONING', 'ACTIVE')`,
      [roleAssignmentId],
    );
    for (const {id} of derived.rows as {id: string}[]) {
      const sub = await requestEntitlementRevocationTx(client, ctx, id, reason);
      result.pendingRevocation.push(...sub.pendingRevocation);
      result.cancelled.push(...sub.cancelled);
    }
    return result;
  });
}

/** Called by the provisioning orchestrator when a role REVOKE completes. */
export async function completeRoleRevocation(
  pool: pg.Pool,
  ctx: AuthzContext,
  roleAssignmentId: string,
  reason: RevocationReason,
): Promise<void> {
  assertPermission(ctx, 'grant:write');
  await withTransaction(pool, (client) =>
    transitionGrant(client, ctx, 'role_assignments', roleAssignmentId, 'REVOKED', {
      revokedReason: reason,
    }),
  );
}

// ---------------------------------------------------------------------------
// Expiry sweep (working rule 8, enforcement half)
// ---------------------------------------------------------------------------

export interface ExpirySweepResult {
  roleAssignments: RevocationResult;
  entitlementAssignments: RevocationResult;
}

/**
 * Finds every live grant whose expiry has passed and pushes it into the
 * revocation pipeline with reason EXPIRY. Run by the platform worker on a
 * schedule; safe to run repeatedly.
 */
export async function sweepExpiredGrants(
  pool: pg.Pool,
  ctx: AuthzContext,
  now: Date = new Date(),
): Promise<ExpirySweepResult> {
  assertPermission(ctx, 'grant:write');

  return withTransaction(pool, async (client) => {
    const result: ExpirySweepResult = {
      roleAssignments: {pendingRevocation: [], cancelled: []},
      entitlementAssignments: {pendingRevocation: [], cancelled: []},
    };

    // Expired role assignments cascade to their derived grants.
    const expiredRoles = await client.query(
      `SELECT id FROM role_assignments
       WHERE expires_at IS NOT NULL AND expires_at <= $1
         AND status IN ('PENDING_PROVISIONING', 'ACTIVE')
       ORDER BY id FOR UPDATE`,
      [now],
    );
    for (const {id} of expiredRoles.rows as {id: string}[]) {
      const {rows} = await client.query('SELECT status FROM role_assignments WHERE id = $1', [id]);
      const to = rows[0].status === 'PENDING_PROVISIONING' ? 'CANCELLED' : 'PENDING_REVOCATION';
      await transitionGrant(client, ctx, 'role_assignments', id, to, {revokedReason: 'EXPIRY'});
      (to === 'CANCELLED'
        ? result.roleAssignments.cancelled
        : result.roleAssignments.pendingRevocation
      ).push(id);
      const derived = await client.query(
        `SELECT id FROM entitlement_assignments
         WHERE source_role_assignment_id = $1
           AND status IN ('PENDING_PROVISIONING', 'ACTIVE')`,
        [id],
      );
      for (const row of derived.rows as {id: string}[]) {
        const sub = await requestEntitlementRevocationTx(client, ctx, row.id, 'EXPIRY');
        result.entitlementAssignments.pendingRevocation.push(...sub.pendingRevocation);
        result.entitlementAssignments.cancelled.push(...sub.cancelled);
      }
    }

    // Directly expired entitlement grants.
    const expiredGrants = await client.query(
      `SELECT id FROM entitlement_assignments
       WHERE expires_at IS NOT NULL AND expires_at <= $1
         AND status IN ('PENDING_PROVISIONING', 'ACTIVE')
       ORDER BY id FOR UPDATE`,
      [now],
    );
    for (const {id} of expiredGrants.rows as {id: string}[]) {
      const sub = await requestEntitlementRevocationTx(client, ctx, id, 'EXPIRY');
      result.entitlementAssignments.pendingRevocation.push(...sub.pendingRevocation);
      result.entitlementAssignments.cancelled.push(...sub.cancelled);
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Everything an identity currently holds — roles and technical grants. */
export async function listIdentityAccess(
  pool: pg.Pool,
  ctx: AuthzContext,
  identityId: string,
): Promise<{roles: RoleAssignment[]; entitlements: EntitlementAssignment[]}> {
  assertPermission(ctx, 'grant:read');
  const live = ['PENDING_PROVISIONING', 'ACTIVE', 'PENDING_REVOCATION'];
  const [roles, entitlements] = await Promise.all([
    pool.query(
      `SELECT * FROM role_assignments WHERE identity_id = $1 AND status = ANY($2) ORDER BY created_at`,
      [identityId, live],
    ),
    pool.query(
      `SELECT * FROM entitlement_assignments WHERE identity_id = $1 AND status = ANY($2) ORDER BY created_at`,
      [identityId, live],
    ),
  ]);
  return {
    roles: roles.rows.map((r) => mapRoleAssignment(r as Record<string, unknown>)),
    entitlements: entitlements.rows.map((r) =>
      mapEntitlementAssignment(r as Record<string, unknown>),
    ),
  };
}
