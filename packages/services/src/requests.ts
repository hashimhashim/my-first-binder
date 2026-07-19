/**
 * Access request + approval workflow.
 *
 * Submission (one transaction):
 *   1. Validate items (role or entitlement; direct entitlement items are the
 *      exception path and MUST carry an expiry).
 *   2. Evaluate SoD rules against requested + currently-held access:
 *      BLOCK rejects the submission, REQUIRE_APPROVAL forces the security
 *      stage, WARN is recorded in sod_flags for approver visibility.
 *   3. Compute the approval chain: MANAGER -> APP_OWNER(s) -> SECURITY.
 *      The security stage is forced for privileged/high-risk targets, all
 *      direct entitlement items, and SoD REQUIRE_APPROVAL hits. The same
 *      person never appears twice, and the beneficiary never appears at all
 *      (also DB-enforced).
 *
 * Decision (one transaction per decision):
 *   - Stages decide strictly in order; a rejection at any stage rejects the
 *     whole request; the final approval fulfills the request through the
 *     grant pipeline (roles expand, direct items become EXCEPTION grants
 *     with a policy_exceptions record naming the security approver).
 *
 * Every submission, decision, rejection, cancellation, SoD hit, and
 * fulfillment writes an audit event in the same transaction.
 */

import {
  assertTransition,
  InvariantViolation,
  requestLifecycle,
  type AccessRequest,
  type ApprovalStageType,
  type RequestItemTarget,
  type RequestStatus,
  type RiskLevel,
} from '@iam/domain';
import type pg from 'pg';
import {writeAuditEvent} from './audit.js';
import {assertPermission, type AuthzContext} from './context.js';
import {assignRoleTx, grantExceptionTx} from './grants.js';
import {NotFoundError} from './identities.js';
import {withTransaction} from './tx.js';

const HIGH_RISK: readonly RiskLevel[] = ['HIGH', 'CRITICAL'];
const LIVE_STATUSES = ['PENDING_PROVISIONING', 'ACTIVE', 'PENDING_REVOCATION'];

function mapRequest(row: Record<string, unknown>): AccessRequest {
  return {
    id: row['id'] as string,
    requesterIdentityId: row['requester_identity_id'] as string,
    beneficiaryIdentityId: row['beneficiary_identity_id'] as string,
    justification: row['justification'] as string,
    status: row['status'] as RequestStatus,
    sodFlags: row['sod_flags'] as unknown[],
    submittedAt: row['submitted_at'] as Date | null,
    decidedAt: row['decided_at'] as Date | null,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface RequestItemInput {
  targetType: RequestItemTarget;
  roleId?: string;
  entitlementId?: string;
  /** Makes a role grant TEMPORARY; MANDATORY for direct entitlement items. */
  requestedExpiresAt?: Date | null;
}

export interface SubmitRequestInput {
  /** Defaults to the requester (self-service). */
  beneficiaryIdentityId?: string;
  justification: string;
  items: RequestItemInput[];
}

export interface SubmitRequestResult {
  request: AccessRequest;
  approvalStages: Array<{
    stageOrder: number;
    stageType: ApprovalStageType;
    approverIdentityId: string;
  }>;
  sodFlags: SodFlag[];
}

export interface SodFlag {
  ruleId: string;
  ruleName: string;
  severity: 'REQUIRE_APPROVAL' | 'WARN';
  conflictingTarget: string;
  requestedTarget: string;
}

export async function submitAccessRequest(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: SubmitRequestInput,
): Promise<SubmitRequestResult> {
  assertPermission(ctx, 'request:submit');
  if (ctx.actorIdentityId === null) {
    throw new InvariantViolation('HUMAN_ACTOR_REQUIRED', 'access requests are submitted by people');
  }
  if (input.items.length === 0) {
    throw new InvariantViolation('EMPTY_REQUEST', 'an access request needs at least one item');
  }
  if (input.justification.trim().length === 0) {
    throw new InvariantViolation('JUSTIFICATION_REQUIRED', 'access requests require a justification');
  }
  for (const item of input.items) {
    const hasRole = item.roleId != null;
    const hasEntitlement = item.entitlementId != null;
    if (
      (item.targetType === 'ROLE' && (!hasRole || hasEntitlement)) ||
      (item.targetType === 'ENTITLEMENT' && (!hasEntitlement || hasRole))
    ) {
      throw new InvariantViolation('ITEM_TARGET_MISMATCH', 'item target must match its type');
    }
    if (item.targetType === 'ENTITLEMENT' && item.requestedExpiresAt == null) {
      throw new InvariantViolation(
        'EXPIRY_REQUIRED',
        'direct entitlement access is exception access and must carry an expiry date',
      );
    }
  }

  const beneficiaryId = input.beneficiaryIdentityId ?? ctx.actorIdentityId;

  return withTransaction(pool, async (client) => {
    const beneficiary = await client.query(
      'SELECT status, manager_id FROM identities WHERE id = $1',
      [beneficiaryId],
    );
    if (beneficiary.rows.length === 0) {
      throw new NotFoundError('identity', beneficiaryId);
    }
    if (!['ACTIVE', 'PENDING'].includes(beneficiary.rows[0].status as string)) {
      throw new InvariantViolation(
        'IDENTITY_NOT_GRANTABLE',
        `identity ${beneficiaryId} cannot receive new access`,
      );
    }

    const targets = await resolveTargets(client, input.items);
    const sod = await evaluateSod(client, beneficiaryId, targets);
    const blocked = sod.filter((f) => f.severity === 'BLOCK');
    if (blocked.length > 0) {
      throw new InvariantViolation(
        'SOD_BLOCKED',
        `segregation-of-duties violation: ${blocked.map((b) => b.ruleName).join(', ')}`,
      );
    }
    const sodFlags = sod as SodFlag[]; // BLOCKs thrown above; rest are flags

    const requestRes = await client.query(
      `INSERT INTO access_requests
         (requester_identity_id, beneficiary_identity_id, justification, status, sod_flags, submitted_at)
       VALUES ($1, $2, $3, 'PENDING_APPROVAL', $4, now()) RETURNING *`,
      [ctx.actorIdentityId, beneficiaryId, input.justification, JSON.stringify(sodFlags)],
    );
    const request = mapRequest(requestRes.rows[0] as Record<string, unknown>);

    for (const item of input.items) {
      await client.query(
        `INSERT INTO access_request_items
           (request_id, target_type, role_id, entitlement_id, requested_expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          request.id,
          item.targetType,
          item.roleId ?? null,
          item.entitlementId ?? null,
          item.requestedExpiresAt ?? null,
        ],
      );
    }

    const approvalStages = await computeApprovalChain(client, {
      beneficiaryId,
      managerId: beneficiary.rows[0].manager_id as string | null,
      targets,
      sodRequiresSecurity: sodFlags.some((f) => f.severity === 'REQUIRE_APPROVAL'),
    });
    for (const stage of approvalStages) {
      await client.query(
        `INSERT INTO approvals (request_id, stage_order, stage_type, approver_identity_id)
         VALUES ($1, $2, $3, $4)`,
        [request.id, stage.stageOrder, stage.stageType, stage.approverIdentityId],
      );
    }

    await writeAuditEvent(client, ctx, {
      action: 'access_request.submitted',
      entityType: 'access_request',
      entityId: request.id,
      afterState: {
        beneficiaryId,
        items: input.items,
        approvalStages,
        sodFlags,
      },
    });
    for (const flag of sodFlags) {
      await writeAuditEvent(client, ctx, {
        action: 'sod_violation.detected',
        entityType: 'access_request',
        entityId: request.id,
        afterState: flag,
      });
    }

    return {request, approvalStages, sodFlags};
  });
}

// ---------------------------------------------------------------------------
// Target resolution, SoD, approval chain
// ---------------------------------------------------------------------------

interface ResolvedTargets {
  roleIds: string[];
  /** Directly requested entitlements (exception path). */
  directEntitlementIds: string[];
  /** All entitlement ids the request would confer (role expansions + direct). */
  allEntitlementIds: string[];
  applicationIds: string[];
  requiresSecurity: boolean;
}

async function resolveTargets(
  client: pg.ClientBase,
  items: RequestItemInput[],
): Promise<ResolvedTargets> {
  const roleIds = items.filter((i) => i.targetType === 'ROLE').map((i) => i.roleId!);
  const directEntitlementIds = items
    .filter((i) => i.targetType === 'ENTITLEMENT')
    .map((i) => i.entitlementId!);

  let requiresSecurity = directEntitlementIds.length > 0; // exceptions always
  const allEntitlementIds = [...directEntitlementIds];
  const applicationIds = new Set<string>();

  if (roleIds.length > 0) {
    const roles = await client.query(
      `SELECT id, status, risk_level, requires_security_approval FROM business_roles WHERE id = ANY($1)`,
      [roleIds],
    );
    if (roles.rows.length !== new Set(roleIds).size) {
      throw new NotFoundError('business_role', roleIds.join(','));
    }
    for (const row of roles.rows) {
      if (row.status !== 'ACTIVE') {
        throw new InvariantViolation('ROLE_DISABLED', 'disabled roles cannot be requested');
      }
      if (row.requires_security_approval || HIGH_RISK.includes(row.risk_level as RiskLevel)) {
        requiresSecurity = true;
      }
    }
    const expansion = await client.query(
      `SELECT re.entitlement_id, e.application_id, e.risk_level, e.is_privileged
       FROM role_entitlements re JOIN entitlements e ON e.id = re.entitlement_id
       WHERE re.role_id = ANY($1)`,
      [roleIds],
    );
    for (const row of expansion.rows) {
      allEntitlementIds.push(row.entitlement_id as string);
      applicationIds.add(row.application_id as string);
      if (row.is_privileged || HIGH_RISK.includes(row.risk_level as RiskLevel)) {
        requiresSecurity = true;
      }
    }
  }

  if (directEntitlementIds.length > 0) {
    const ents = await client.query(
      `SELECT id, application_id, status, risk_level, is_privileged FROM entitlements WHERE id = ANY($1)`,
      [directEntitlementIds],
    );
    if (ents.rows.length !== new Set(directEntitlementIds).size) {
      throw new NotFoundError('entitlement', directEntitlementIds.join(','));
    }
    for (const row of ents.rows) {
      if (row.status === 'DEPRECATED') {
        throw new InvariantViolation(
          'ENTITLEMENT_DEPRECATED',
          'deprecated entitlements cannot be requested',
        );
      }
      applicationIds.add(row.application_id as string);
      if (row.is_privileged || HIGH_RISK.includes(row.risk_level as RiskLevel)) {
        requiresSecurity = true;
      }
    }
  }

  return {
    roleIds,
    directEntitlementIds,
    allEntitlementIds: [...new Set(allEntitlementIds)],
    applicationIds: [...applicationIds],
    requiresSecurity,
  };
}

interface SodHit extends Omit<SodFlag, 'severity'> {
  severity: 'BLOCK' | 'REQUIRE_APPROVAL' | 'WARN';
}

/**
 * A rule fires when its two sides are both present in the union of
 * (currently-held live access) and (requested access), with at least one
 * side coming from the request.
 */
async function evaluateSod(
  client: pg.ClientBase,
  beneficiaryId: string,
  targets: ResolvedTargets,
): Promise<SodHit[]> {
  const held = await client.query(
    `SELECT 'ROLE' AS kind, role_id AS target_id FROM role_assignments
       WHERE identity_id = $1 AND status = ANY($2)
     UNION
     SELECT 'ENTITLEMENT' AS kind, entitlement_id AS target_id FROM entitlement_assignments
       WHERE identity_id = $1 AND status = ANY($2)`,
    [beneficiaryId, LIVE_STATUSES],
  );
  const heldRoles = new Set(
    held.rows.filter((r) => r.kind === 'ROLE').map((r) => r.target_id as string),
  );
  const heldEnts = new Set(
    held.rows.filter((r) => r.kind === 'ENTITLEMENT').map((r) => r.target_id as string),
  );
  const reqRoles = new Set(targets.roleIds);
  const reqEnts = new Set(targets.allEntitlementIds);

  const rules = await client.query(
    `SELECT * FROM sod_rules WHERE status = 'ACTIVE'`,
  );
  const hits: SodHit[] = [];
  for (const rule of rules.rows) {
    const side = (type: string, roleId: string | null, entId: string | null) => {
      const id = (type === 'ROLE' ? roleId : entId) as string;
      return {
        id,
        held: type === 'ROLE' ? heldRoles.has(id) : heldEnts.has(id),
        requested: type === 'ROLE' ? reqRoles.has(id) : reqEnts.has(id),
      };
    };
    const first = side(rule.first_target_type, rule.first_role_id, rule.first_entitlement_id);
    const second = side(rule.second_target_type, rule.second_role_id, rule.second_entitlement_id);
    const firstPresent = first.held || first.requested;
    const secondPresent = second.held || second.requested;
    const involvesRequest = first.requested || second.requested;
    if (firstPresent && secondPresent && involvesRequest) {
      hits.push({
        ruleId: rule.id as string,
        ruleName: rule.name as string,
        severity: rule.severity as SodHit['severity'],
        conflictingTarget: first.requested ? second.id : first.id,
        requestedTarget: first.requested ? first.id : second.id,
      });
    }
  }
  return hits;
}

interface ChainInput {
  beneficiaryId: string;
  managerId: string | null;
  targets: ResolvedTargets;
  sodRequiresSecurity: boolean;
}

async function computeApprovalChain(
  client: pg.ClientBase,
  input: ChainInput,
): Promise<SubmitRequestResult['approvalStages']> {
  const stages: SubmitRequestResult['approvalStages'] = [];
  const seen = new Set<string>();
  let stageOrder = 0;

  const addStage = (stageType: ApprovalStageType, approverIds: string[]) => {
    // Never the beneficiary; never the same approver twice across stages.
    const approvers = [...new Set(approverIds)].filter(
      (id) => id !== input.beneficiaryId && !seen.has(id),
    );
    if (approvers.length === 0) {
      return false;
    }
    stageOrder += 1;
    for (const approverIdentityId of approvers) {
      seen.add(approverIdentityId);
      stages.push({stageOrder, stageType, approverIdentityId});
    }
    return true;
  };

  if (input.managerId !== null) {
    addStage('MANAGER', [input.managerId]);
  }

  const apps = await client.query(
    `SELECT owner_identity_id, security_officer_identity_id, name
     FROM applications WHERE id = ANY($1)`,
    [input.targets.applicationIds],
  );
  addStage(
    'APP_OWNER',
    apps.rows.map((a) => a.owner_identity_id as string),
  );

  const needSecurity = input.targets.requiresSecurity || input.sodRequiresSecurity;
  if (needSecurity) {
    const officers = apps.rows
      .map((a) => a.security_officer_identity_id as string | null)
      .filter((id): id is string => id !== null);
    if (officers.length === 0) {
      throw new InvariantViolation(
        'SECURITY_OFFICER_REQUIRED',
        'this request requires security approval but no security officer is configured for the target application(s)',
      );
    }
    const added = addStage('SECURITY', officers);
    if (!added) {
      throw new InvariantViolation(
        'SECURITY_OFFICER_REQUIRED',
        'security approval is required but every configured security officer is excluded (beneficiary or already an approver)',
      );
    }
  }

  if (stages.length === 0) {
    throw new InvariantViolation(
      'NO_APPROVERS',
      'no eligible approvers could be determined for this request',
    );
  }
  return stages;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface DecideApprovalInput {
  requestId: string;
  decision: 'APPROVED' | 'REJECTED';
  comment?: string;
}

export interface DecideApprovalResult {
  requestStatus: RequestStatus;
  /** Set when this decision completed the chain and the request was fulfilled. */
  fulfilled: boolean;
}

export async function decideApproval(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  assertPermission(ctx, 'request:approve');
  if (ctx.actorIdentityId === null) {
    throw new InvariantViolation('HUMAN_ACTOR_REQUIRED', 'approvals are decided by people');
  }

  return withTransaction(pool, async (client) => {
    const requestRes = await client.query(
      'SELECT * FROM access_requests WHERE id = $1 FOR UPDATE',
      [input.requestId],
    );
    if (requestRes.rows.length === 0) {
      throw new NotFoundError('access_request', input.requestId);
    }
    const request = mapRequest(requestRes.rows[0] as Record<string, unknown>);
    if (request.status !== 'PENDING_APPROVAL') {
      throw new InvariantViolation(
        'REQUEST_NOT_PENDING',
        `request is ${request.status}, not awaiting approval`,
      );
    }

    const approvals = await client.query(
      `SELECT * FROM approvals WHERE request_id = $1 ORDER BY stage_order FOR UPDATE`,
      [input.requestId],
    );
    const mine = approvals.rows.find(
      (a) => a.approver_identity_id === ctx.actorIdentityId && a.decision === 'PENDING',
    );
    if (mine === undefined) {
      throw new InvariantViolation(
        'NOT_AN_APPROVER',
        'caller has no pending approval on this request',
      );
    }
    const earlierPending = approvals.rows.some(
      (a) => a.decision === 'PENDING' && a.stage_order < mine.stage_order,
    );
    if (earlierPending) {
      throw new InvariantViolation(
        'STAGE_ORDER',
        'earlier approval stages must be decided first',
      );
    }

    await client.query(
      `UPDATE approvals SET decision = $2, comment = $3, decided_at = now() WHERE id = $1`,
      [mine.id, input.decision, input.comment ?? null],
    );
    await writeAuditEvent(client, ctx, {
      action: 'approval.decided',
      entityType: 'access_request',
      entityId: request.id,
      afterState: {
        approvalId: mine.id,
        stageType: mine.stage_type,
        decision: input.decision,
        comment: input.comment ?? null,
      },
    });

    if (input.decision === 'REJECTED') {
      assertTransition(requestLifecycle, 'PENDING_APPROVAL', 'REJECTED');
      await client.query(
        `UPDATE access_requests SET status = 'REJECTED', decided_at = now() WHERE id = $1`,
        [request.id],
      );
      await client.query(
        `UPDATE access_request_items SET status = 'REJECTED' WHERE request_id = $1`,
        [request.id],
      );
      await writeAuditEvent(client, ctx, {
        action: 'access_request.rejected',
        entityType: 'access_request',
        entityId: request.id,
        afterState: {rejectedBy: ctx.actorIdentityId, stageType: mine.stage_type},
      });
      return {requestStatus: 'REJECTED', fulfilled: false};
    }

    const stillPending = approvals.rows.some(
      (a) => a.id !== mine.id && a.decision === 'PENDING',
    );
    if (stillPending) {
      return {requestStatus: 'PENDING_APPROVAL', fulfilled: false};
    }

    // Chain complete: approve, then fulfill through the grant pipeline.
    assertTransition(requestLifecycle, 'PENDING_APPROVAL', 'APPROVED');
    await client.query(
      `UPDATE access_requests SET status = 'APPROVED', decided_at = now() WHERE id = $1`,
      [request.id],
    );
    await client.query(
      `UPDATE access_request_items SET status = 'APPROVED' WHERE request_id = $1`,
      [request.id],
    );
    await writeAuditEvent(client, ctx, {
      action: 'access_request.approved',
      entityType: 'access_request',
      entityId: request.id,
    });

    await fulfillRequest(client, ctx, request, approvals.rows);

    assertTransition(requestLifecycle, 'APPROVED', 'PROVISIONED');
    await client.query(
      `UPDATE access_requests SET status = 'PROVISIONED' WHERE id = $1`,
      [request.id],
    );
    await client.query(
      `UPDATE access_request_items SET status = 'PROVISIONED' WHERE request_id = $1`,
      [request.id],
    );
    await writeAuditEvent(client, ctx, {
      action: 'access_request.provisioned',
      entityType: 'access_request',
      entityId: request.id,
    });
    return {requestStatus: 'PROVISIONED', fulfilled: true};
  });
}

async function fulfillRequest(
  client: pg.PoolClient,
  ctx: AuthzContext,
  request: AccessRequest,
  approvals: Array<Record<string, unknown>>,
): Promise<void> {
  const items = await client.query(
    'SELECT * FROM access_request_items WHERE request_id = $1',
    [request.id],
  );
  const securityApprover = approvals.find((a) => a['stage_type'] === 'SECURITY');

  for (const item of items.rows) {
    if (item.target_type === 'ROLE') {
      await assignRoleTx(client, ctx, {
        identityId: request.beneficiaryIdentityId,
        roleId: item.role_id as string,
        assignmentType: item.requested_expires_at === null ? 'REQUESTED' : 'TEMPORARY',
        expiresAt: item.requested_expires_at as Date | null,
        grantedViaRequestId: request.id,
      });
    } else {
      // Direct entitlement = exception access. The security stage is
      // mandatory for these (enforced at submission), so the approver of
      // record for the policy exception is the security approver.
      if (securityApprover === undefined) {
        throw new InvariantViolation(
          'SECURITY_APPROVAL_MISSING',
          'exception fulfillment requires a security-stage approval',
        );
      }
      await grantExceptionTx(client, ctx, {
        identityId: request.beneficiaryIdentityId,
        entitlementId: item.entitlement_id as string,
        justification: request.justification,
        approvedByIdentityId: securityApprover['approver_identity_id'] as string,
        expiresAt: item.requested_expires_at as Date,
        grantedViaRequestId: request.id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Cancellation & audit trail
// ---------------------------------------------------------------------------

export async function cancelAccessRequest(
  pool: pg.Pool,
  ctx: AuthzContext,
  requestId: string,
): Promise<void> {
  assertPermission(ctx, 'request:submit');

  await withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      'SELECT * FROM access_requests WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('access_request', requestId);
    }
    const request = mapRequest(rows[0] as Record<string, unknown>);
    if (request.requesterIdentityId !== ctx.actorIdentityId) {
      throw new InvariantViolation(
        'NOT_REQUESTER',
        'only the requester can cancel an access request',
      );
    }
    assertTransition(requestLifecycle, request.status, 'CANCELLED');
    await client.query(
      `UPDATE access_requests SET status = 'CANCELLED', decided_at = now() WHERE id = $1`,
      [requestId],
    );
    await client.query(
      `UPDATE access_request_items SET status = 'CANCELLED' WHERE request_id = $1 AND status = 'PENDING'`,
      [requestId],
    );
    await writeAuditEvent(client, ctx, {
      action: 'access_request.cancelled',
      entityType: 'access_request',
      entityId: requestId,
    });
  });
}

export interface RequestTrail {
  request: AccessRequest;
  items: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
  grants: {
    roleAssignments: Array<Record<string, unknown>>;
    entitlementAssignments: Array<Record<string, unknown>>;
  };
}

/**
 * Full evidence chain for one request: items, per-stage approvals, resulting
 * grants, and every audit event — the compliance answer to "who asked,
 * who approved, what was granted, and when".
 */
export async function getRequestTrail(
  pool: pg.Pool,
  ctx: AuthzContext,
  requestId: string,
): Promise<RequestTrail> {
  assertPermission(ctx, 'request:read');
  const requestRes = await pool.query('SELECT * FROM access_requests WHERE id = $1', [requestId]);
  if (requestRes.rows.length === 0) {
    throw new NotFoundError('access_request', requestId);
  }
  const [items, approvals, audit, roleGrants, entGrants] = await Promise.all([
    pool.query('SELECT * FROM access_request_items WHERE request_id = $1', [requestId]),
    pool.query('SELECT * FROM approvals WHERE request_id = $1 ORDER BY stage_order', [requestId]),
    pool.query(
      `SELECT * FROM audit_events WHERE entity_type = 'access_request' AND entity_id = $1
       ORDER BY occurred_at`,
      [requestId],
    ),
    pool.query('SELECT * FROM role_assignments WHERE granted_via_request_id = $1', [requestId]),
    pool.query('SELECT * FROM entitlement_assignments WHERE granted_via_request_id = $1', [
      requestId,
    ]),
  ]);
  return {
    request: mapRequest(requestRes.rows[0] as Record<string, unknown>),
    items: items.rows,
    approvals: approvals.rows,
    auditEvents: audit.rows,
    grants: {roleAssignments: roleGrants.rows, entitlementAssignments: entGrants.rows},
  };
}
