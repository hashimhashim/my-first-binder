/**
 * Lifecycle automation: turns the JML journal (lifecycle_events) into access
 * changes. Run by the platform worker on a schedule (and by the dev tick).
 *
 *  JOINER / MOVER / ATTRIBUTE_CHANGE
 *      Evaluate birthright rules (role_assignment_rules): assign matching
 *      roles the identity lacks; on MOVER, revoke BIRTHRIGHT roles that no
 *      longer match (reason MOVER). Requested/temporary access is never
 *      touched by the rule engine.
 *
 *  LEAVER (terminal transition only)
 *      Kill-switch: revoke every live role assignment and entitlement
 *      grant (reason LEAVER), cancel the identity's open access requests,
 *      and disable their target-system accounts. Deprovisioning jobs are
 *      then created by the provisioning sweep as usual.
 *
 * Each event is processed in its own transaction and stamped with
 * processed_at plus a resulting_actions summary, so the journal is both
 * the work queue and the evidence of what automation did.
 */

import type {LifecycleEventType} from '@iam/domain';
import type pg from 'pg';
import {writeAuditEvent} from './audit.js';
import {assertPermission, type AuthzContext} from './context.js';
import {
  assignRoleTx,
  requestEntitlementRevocationTx,
  requestRoleRevocationTx,
} from './grants.js';
import {withTransaction} from './tx.js';

export interface LifecycleActions {
  rolesAssigned: string[];
  rolesRevoked: string[];
  grantsRevoked: string[];
  requestsCancelled: string[];
  accountsDisabled: string[];
}

export interface ProcessResult {
  processed: Array<{eventId: string; eventType: LifecycleEventType; actions: LifecycleActions}>;
}

const MATCHABLE_ATTRIBUTES: Record<string, string> = {
  identityType: 'identity_type',
  department: 'department',
  businessUnit: 'business_unit',
  location: 'location',
  jobTitle: 'job_title',
};

/** Case-insensitive equality match of a rule's attribute_filter against an identity row. */
export function ruleMatchesIdentity(
  filter: Record<string, unknown>,
  identity: Record<string, unknown>,
): boolean {
  const entries = Object.entries(filter);
  if (entries.length === 0) {
    return false; // an empty filter matching everyone is almost never intended
  }
  for (const [key, expected] of entries) {
    const column = MATCHABLE_ATTRIBUTES[key];
    if (column === undefined) {
      return false; // unknown attribute: fail closed
    }
    const actual = identity[column];
    if (
      typeof expected !== 'string' ||
      typeof actual !== 'string' ||
      actual.toLowerCase() !== expected.toLowerCase()
    ) {
      return false;
    }
  }
  return true;
}

export async function processLifecycleEvents(
  pool: pg.Pool,
  ctx: AuthzContext,
  options: {limit?: number} = {},
): Promise<ProcessResult> {
  assertPermission(ctx, 'grant:write');
  assertPermission(ctx, 'identity:lifecycle');

  const due = await pool.query(
    `SELECT id FROM lifecycle_events WHERE processed_at IS NULL
     ORDER BY occurred_at LIMIT $1`,
    [options.limit ?? 50],
  );

  const result: ProcessResult = {processed: []};
  for (const {id} of due.rows as {id: string}[]) {
    const outcome = await withTransaction(pool, (client) => processOne(client, ctx, id));
    if (outcome !== null) {
      result.processed.push(outcome);
    }
  }
  return result;
}

async function processOne(
  client: pg.PoolClient,
  ctx: AuthzContext,
  eventId: string,
): Promise<ProcessResult['processed'][number] | null> {
  const eventRes = await client.query(
    `SELECT * FROM lifecycle_events WHERE id = $1 AND processed_at IS NULL FOR UPDATE SKIP LOCKED`,
    [eventId],
  );
  if (eventRes.rows.length === 0) {
    return null;
  }
  const event = eventRes.rows[0] as Record<string, unknown>;
  const eventType = event['event_type'] as LifecycleEventType;
  const identityId = event['identity_id'] as string;

  const identityRes = await client.query('SELECT * FROM identities WHERE id = $1 FOR UPDATE', [
    identityId,
  ]);
  const identity = identityRes.rows[0] as Record<string, unknown>;

  const actions: LifecycleActions = {
    rolesAssigned: [],
    rolesRevoked: [],
    grantsRevoked: [],
    requestsCancelled: [],
    accountsDisabled: [],
  };

  if (eventType === 'JOINER' || eventType === 'MOVER' || eventType === 'ATTRIBUTE_CHANGE') {
    if (identity['status'] === 'ACTIVE' || identity['status'] === 'PENDING') {
      await applyBirthrightRules(client, ctx, identity, eventType, actions);
    }
  } else if (eventType === 'LEAVER' && identity['status'] === 'TERMINATED') {
    await runLeaverKillSwitch(client, ctx, identityId, actions);
  }

  await client.query(
    `UPDATE lifecycle_events SET processed_at = now(), resulting_actions = $2 WHERE id = $1`,
    [eventId, JSON.stringify(actions)],
  );

  const auditAction =
    eventType === 'JOINER'
      ? 'identity.joiner_processed'
      : eventType === 'LEAVER'
        ? 'identity.leaver_processed'
        : 'identity.mover_processed';
  await writeAuditEvent(client, ctx, {
    action: auditAction,
    entityType: 'identity',
    entityId: identityId,
    afterState: {lifecycleEventId: eventId, ...actions},
  });

  return {eventId, eventType, actions};
}

async function applyBirthrightRules(
  client: pg.PoolClient,
  ctx: AuthzContext,
  identity: Record<string, unknown>,
  eventType: LifecycleEventType,
  actions: LifecycleActions,
): Promise<void> {
  const identityId = identity['id'] as string;
  const rules = await client.query(
    `SELECT rar.role_id, rar.attribute_filter FROM role_assignment_rules rar
     JOIN business_roles br ON br.id = rar.role_id AND br.status = 'ACTIVE'
     WHERE rar.status = 'ACTIVE' ORDER BY rar.priority`,
  );
  const desiredRoleIds = new Set(
    (rules.rows as Array<{role_id: string; attribute_filter: Record<string, unknown>}>)
      .filter((r) => ruleMatchesIdentity(r.attribute_filter, identity))
      .map((r) => r.role_id),
  );

  const held = await client.query(
    `SELECT id, role_id FROM role_assignments
     WHERE identity_id = $1 AND assignment_type = 'BIRTHRIGHT'
       AND status IN ('PENDING_PROVISIONING', 'ACTIVE')`,
    [identityId],
  );
  const heldByRole = new Map(
    (held.rows as Array<{id: string; role_id: string}>).map((r) => [r.role_id, r.id]),
  );

  for (const roleId of desiredRoleIds) {
    if (!heldByRole.has(roleId)) {
      const assigned = await assignRoleTx(client, ctx, {
        identityId,
        roleId,
        assignmentType: 'BIRTHRIGHT',
      });
      actions.rolesAssigned.push(assigned.roleAssignment.id);
    }
  }

  // Movers lose birthright roles their new attributes no longer justify.
  if (eventType === 'MOVER') {
    for (const [roleId, assignmentId] of heldByRole) {
      if (!desiredRoleIds.has(roleId)) {
        await requestRoleRevocationTx(client, ctx, assignmentId, 'MOVER');
        actions.rolesRevoked.push(assignmentId);
      }
    }
  }
}

async function runLeaverKillSwitch(
  client: pg.PoolClient,
  ctx: AuthzContext,
  identityId: string,
  actions: LifecycleActions,
): Promise<void> {
  // 1. Revoke role assignments (cascades to their derived grants).
  const roles = await client.query(
    `SELECT id FROM role_assignments
     WHERE identity_id = $1 AND status IN ('PENDING_PROVISIONING', 'ACTIVE') FOR UPDATE`,
    [identityId],
  );
  for (const {id} of roles.rows as {id: string}[]) {
    await requestRoleRevocationTx(client, ctx, id, 'LEAVER');
    actions.rolesRevoked.push(id);
  }

  // 2. Revoke any remaining live entitlement grants (direct/exception access).
  const grants = await client.query(
    `SELECT id FROM entitlement_assignments
     WHERE identity_id = $1 AND status IN ('PENDING_PROVISIONING', 'ACTIVE') FOR UPDATE`,
    [identityId],
  );
  for (const {id} of grants.rows as {id: string}[]) {
    const sub = await requestEntitlementRevocationTx(client, ctx, id, 'LEAVER');
    actions.grantsRevoked.push(...sub.pendingRevocation, ...sub.cancelled);
  }

  // 3. Cancel open access requests where the leaver is the beneficiary.
  const requests = await client.query(
    `UPDATE access_requests SET status = 'CANCELLED', decided_at = now()
     WHERE beneficiary_identity_id = $1 AND status IN ('DRAFT', 'PENDING_APPROVAL')
     RETURNING id`,
    [identityId],
  );
  for (const {id} of requests.rows as {id: string}[]) {
    await client.query(
      `UPDATE access_request_items SET status = 'CANCELLED'
       WHERE request_id = $1 AND status = 'PENDING'`,
      [id],
    );
    await writeAuditEvent(client, ctx, {
      action: 'access_request.cancelled',
      entityType: 'access_request',
      entityId: id,
      afterState: {reason: 'beneficiary terminated'},
    });
    actions.requestsCancelled.push(id);
  }

  // 4. Disable the leaver's target-system accounts.
  const accounts = await client.query(
    `UPDATE identity_accounts SET status = 'DISABLED'
     WHERE identity_id = $1 AND status = 'ACTIVE' RETURNING id`,
    [identityId],
  );
  for (const {id} of accounts.rows as {id: string}[]) {
    await writeAuditEvent(client, ctx, {
      action: 'identity_account.status_changed',
      entityType: 'identity_account',
      entityId: id,
      beforeState: {status: 'ACTIVE'},
      afterState: {status: 'DISABLED', reason: 'LEAVER'},
    });
    actions.accountsDisabled.push(id);
  }
}

// ---------------------------------------------------------------------------
// Birthright rule administration
// ---------------------------------------------------------------------------

export async function createAssignmentRule(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: {roleId: string; name: string; attributeFilter: Record<string, string>; priority?: number},
): Promise<{id: string}> {
  assertPermission(ctx, 'role:write');
  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `INSERT INTO role_assignment_rules (role_id, name, attribute_filter, priority)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.roleId, input.name, JSON.stringify(input.attributeFilter), input.priority ?? 100],
    );
    const id = (rows[0] as {id: string}).id;
    await writeAuditEvent(client, ctx, {
      action: 'assignment_rule.created',
      entityType: 'assignment_rule',
      entityId: id,
      afterState: input,
    });
    return {id};
  });
}
