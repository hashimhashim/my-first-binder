/**
 * Identity repository service: CRUD for identities, lifecycle status
 * transitions (JML), and linked target-system accounts.
 *
 * Every mutation: backend permission check -> domain invariant check ->
 * write + lifecycle journal (where applicable) + audit event, all in one
 * transaction.
 */

import {
  assertIdentityShape,
  assertTransition,
  identityLifecycle,
  type AccountType,
  type Identity,
  type IdentityAccount,
  type IdentitySource,
  type IdentityStatus,
  type IdentityType,
  type LifecycleEventType,
} from '@iam/domain';
import type pg from 'pg';
import {writeAuditEvent} from './audit.js';
import {assertPermission, type AuthzContext} from './context.js';
import {withTransaction} from './tx.js';

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function mapIdentity(row: Record<string, unknown>): Identity {
  return {
    id: row['id'] as string,
    identityType: row['identity_type'] as IdentityType,
    employeeNumber: row['employee_number'] as string | null,
    displayName: row['display_name'] as string,
    givenName: row['given_name'] as string | null,
    familyName: row['family_name'] as string | null,
    primaryEmail: row['primary_email'] as string | null,
    managerId: row['manager_id'] as string | null,
    department: row['department'] as string | null,
    businessUnit: row['business_unit'] as string | null,
    location: row['location'] as string | null,
    jobTitle: row['job_title'] as string | null,
    status: row['status'] as IdentityStatus,
    startDate: row['start_date'] as Date | null,
    terminationDate: row['termination_date'] as Date | null,
    sponsorIdentityId: row['sponsor_identity_id'] as string | null,
    linkedIdentityId: row['linked_identity_id'] as string | null,
    source: row['source'] as IdentitySource,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

function mapAccount(row: Record<string, unknown>): IdentityAccount {
  return {
    id: row['id'] as string,
    identityId: row['identity_id'] as string,
    applicationId: row['application_id'] as string,
    accountIdentifier: row['account_identifier'] as string,
    accountType: row['account_type'] as AccountType,
    status: row['status'] as IdentityAccount['status'],
    externalRef: row['external_ref'] as Record<string, unknown>,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateIdentityInput {
  identityType: IdentityType;
  displayName: string;
  employeeNumber?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  primaryEmail?: string | null;
  managerId?: string | null;
  department?: string | null;
  businessUnit?: string | null;
  location?: string | null;
  jobTitle?: string | null;
  startDate?: Date | null;
  terminationDate?: Date | null;
  sponsorIdentityId?: string | null;
  linkedIdentityId?: string | null;
  source?: IdentitySource;
}

export async function createIdentity(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: CreateIdentityInput,
): Promise<Identity> {
  assertPermission(ctx, 'identity:write');
  assertIdentityShape({
    identityType: input.identityType,
    primaryEmail: input.primaryEmail ?? null,
    terminationDate: input.terminationDate ?? null,
    sponsorIdentityId: input.sponsorIdentityId ?? null,
    linkedIdentityId: input.linkedIdentityId ?? null,
  });

  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `INSERT INTO identities
         (identity_type, display_name, employee_number, given_name, family_name,
          primary_email, manager_id, department, business_unit, location, job_title,
          start_date, termination_date, sponsor_identity_id, linked_identity_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        input.identityType,
        input.displayName,
        input.employeeNumber ?? null,
        input.givenName ?? null,
        input.familyName ?? null,
        input.primaryEmail ?? null,
        input.managerId ?? null,
        input.department ?? null,
        input.businessUnit ?? null,
        input.location ?? null,
        input.jobTitle ?? null,
        input.startDate ?? null,
        input.terminationDate ?? null,
        input.sponsorIdentityId ?? null,
        input.linkedIdentityId ?? null,
        input.source ?? 'MANUAL',
      ],
    );
    const identity = mapIdentity(rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'identity.created',
      entityType: 'identity',
      entityId: identity.id,
      afterState: identity,
    });
    return identity;
  });
}

// ---------------------------------------------------------------------------
// Update (attribute changes; mover detection)
// ---------------------------------------------------------------------------

/** Attributes whose change constitutes a MOVER event (re-runs birthright rules downstream). */
const MOVER_ATTRIBUTES = ['managerId', 'department', 'businessUnit', 'location', 'jobTitle'] as const;

const UPDATABLE_COLUMNS: Record<string, string> = {
  displayName: 'display_name',
  givenName: 'given_name',
  familyName: 'family_name',
  primaryEmail: 'primary_email',
  managerId: 'manager_id',
  department: 'department',
  businessUnit: 'business_unit',
  location: 'location',
  jobTitle: 'job_title',
  startDate: 'start_date',
  terminationDate: 'termination_date',
  employeeNumber: 'employee_number',
};

export type UpdateIdentityInput = Partial<
  Pick<Identity, keyof typeof UPDATABLE_COLUMNS & keyof Identity>
>;

export async function updateIdentity(
  pool: pg.Pool,
  ctx: AuthzContext,
  identityId: string,
  input: UpdateIdentityInput,
): Promise<Identity> {
  assertPermission(ctx, 'identity:write');

  return withTransaction(pool, async (client) => {
    const existing = await selectIdentityForUpdate(client, identityId);

    const changed = Object.entries(input).filter(([key, value]) => {
      const current = existing[key as keyof Identity];
      return value !== undefined && !valuesEqual(current, value);
    });
    if (changed.length === 0) {
      return existing;
    }

    // Re-validate the resulting shape (e.g. clearing a contractor end date).
    const next = {...existing, ...Object.fromEntries(changed)} as Identity;
    assertIdentityShape(next);

    const setClauses = changed.map(([key], i) => `${UPDATABLE_COLUMNS[key]} = $${i + 2}`);
    const {rows} = await client.query(
      `UPDATE identities SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      [identityId, ...changed.map(([, value]) => value)],
    );
    const updated = mapIdentity(rows[0] as Record<string, unknown>);

    const beforeState = Object.fromEntries(changed.map(([key]) => [key, existing[key as keyof Identity]]));
    const afterState = Object.fromEntries(changed.map(([key]) => [key, updated[key as keyof Identity]]));

    const isMover = changed.some(([key]) => (MOVER_ATTRIBUTES as readonly string[]).includes(key));
    await insertLifecycleEvent(client, ctx, identityId, isMover ? 'MOVER' : 'ATTRIBUTE_CHANGE', {
      before: beforeState,
      after: afterState,
    });
    await writeAuditEvent(client, ctx, {
      action: 'identity.updated',
      entityType: 'identity',
      entityId: identityId,
      beforeState,
      afterState,
    });
    return updated;
  });
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

// ---------------------------------------------------------------------------
// Lifecycle status transitions (JML)
// ---------------------------------------------------------------------------

const LIFECYCLE_EVENT_FOR_TRANSITION: Partial<
  Record<`${IdentityStatus}->${IdentityStatus}`, LifecycleEventType>
> = {
  'PENDING->ACTIVE': 'JOINER',
  'PENDING->TERMINATED': 'LEAVER',
  'ACTIVE->SUSPENDED': 'SUSPEND',
  'SUSPENDED->ACTIVE': 'REINSTATE',
  'ACTIVE->LEAVING': 'LEAVER',
  'SUSPENDED->LEAVING': 'LEAVER',
  'ACTIVE->TERMINATED': 'LEAVER',
  'SUSPENDED->TERMINATED': 'LEAVER',
  'LEAVING->TERMINATED': 'LEAVER',
  'LEAVING->ACTIVE': 'REINSTATE',
};

export async function changeIdentityStatus(
  pool: pg.Pool,
  ctx: AuthzContext,
  identityId: string,
  newStatus: IdentityStatus,
  reason?: string,
): Promise<Identity> {
  assertPermission(ctx, 'identity:lifecycle');

  return withTransaction(pool, async (client) => {
    const existing = await selectIdentityForUpdate(client, identityId);
    assertTransition(identityLifecycle, existing.status, newStatus);

    const {rows} = await client.query(
      `UPDATE identities SET status = $2 WHERE id = $1 RETURNING *`,
      [identityId, newStatus],
    );
    const updated = mapIdentity(rows[0] as Record<string, unknown>);

    const eventType = LIFECYCLE_EVENT_FOR_TRANSITION[`${existing.status}->${newStatus}`];
    if (eventType !== undefined) {
      await insertLifecycleEvent(client, ctx, identityId, eventType, {
        from: existing.status,
        to: newStatus,
        ...(reason === undefined ? {} : {reason}),
      });
    }
    await writeAuditEvent(client, ctx, {
      action: 'identity.status_changed',
      entityType: 'identity',
      entityId: identityId,
      beforeState: {status: existing.status},
      afterState: {status: newStatus, ...(reason === undefined ? {} : {reason})},
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Linked accounts
// ---------------------------------------------------------------------------

export interface LinkAccountInput {
  identityId: string;
  applicationId: string;
  accountIdentifier: string;
  accountType?: AccountType;
  externalRef?: Record<string, unknown>;
}

export async function linkIdentityAccount(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: LinkAccountInput,
): Promise<IdentityAccount> {
  assertPermission(ctx, 'identity:write');

  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `INSERT INTO identity_accounts
         (identity_id, application_id, account_identifier, account_type, external_ref)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        input.identityId,
        input.applicationId,
        input.accountIdentifier,
        input.accountType ?? 'STANDARD',
        JSON.stringify(input.externalRef ?? {}),
      ],
    );
    const account = mapAccount(rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'identity_account.linked',
      entityType: 'identity_account',
      entityId: account.id,
      afterState: account,
    });
    return account;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getIdentity(
  pool: pg.Pool,
  ctx: AuthzContext,
  identityId: string,
): Promise<Identity> {
  assertPermission(ctx, 'identity:read');
  const {rows} = await pool.query('SELECT * FROM identities WHERE id = $1', [identityId]);
  if (rows.length === 0) {
    throw new NotFoundError('identity', identityId);
  }
  return mapIdentity(rows[0] as Record<string, unknown>);
}

export interface ListIdentitiesFilter {
  status?: IdentityStatus;
  identityType?: IdentityType;
  managerId?: string;
  department?: string;
  limit?: number;
  offset?: number;
}

export async function listIdentities(
  pool: pg.Pool,
  ctx: AuthzContext,
  filter: ListIdentitiesFilter = {},
): Promise<Identity[]> {
  assertPermission(ctx, 'identity:read');
  const clauses: string[] = [];
  const params: unknown[] = [];
  const addFilter = (column: string, value: unknown) => {
    if (value !== undefined) {
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
  };
  addFilter('status', filter.status);
  addFilter('identity_type', filter.identityType);
  addFilter('manager_id', filter.managerId);
  addFilter('department', filter.department);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(filter.limit ?? 100, 500), filter.offset ?? 0);
  const {rows} = await pool.query(
    `SELECT * FROM identities ${where}
     ORDER BY display_name, id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => mapIdentity(r as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function selectIdentityForUpdate(client: pg.ClientBase, identityId: string): Promise<Identity> {
  const {rows} = await client.query('SELECT * FROM identities WHERE id = $1 FOR UPDATE', [identityId]);
  if (rows.length === 0) {
    throw new NotFoundError('identity', identityId);
  }
  return mapIdentity(rows[0] as Record<string, unknown>);
}

async function insertLifecycleEvent(
  client: pg.ClientBase,
  ctx: AuthzContext,
  identityId: string,
  eventType: LifecycleEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO lifecycle_events (identity_id, event_type, payload, triggered_by_identity_id, actor_type)
     VALUES ($1, $2, $3, $4, $5)`,
    [identityId, eventType, JSON.stringify(payload), ctx.actorIdentityId, ctx.actorType],
  );
}
