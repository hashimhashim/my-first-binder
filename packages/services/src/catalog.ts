/**
 * Catalog service: technical entitlements, business roles, and the
 * role -> entitlement mappings that keep the two strictly separate
 * (working rule 9). People are assigned business roles; systems grant
 * technical entitlements; role_entitlements is the only bridge.
 */

import {
  InvariantViolation,
  type BusinessRole,
  type CatalogStatus,
  type Entitlement,
  type EntitlementStatus,
  type RiskLevel,
} from '@iam/domain';
import type pg from 'pg';
import {writeAuditEvent} from './audit.js';
import {assertPermission, type AuthzContext} from './context.js';
import {NotFoundError} from './identities.js';
import {withTransaction} from './tx.js';

function mapEntitlement(row: Record<string, unknown>): Entitlement {
  return {
    id: row['id'] as string,
    applicationId: row['application_id'] as string,
    code: row['code'] as string,
    name: row['name'] as string,
    description: row['description'] as string | null,
    riskLevel: row['risk_level'] as RiskLevel,
    isPrivileged: row['is_privileged'] as boolean,
    externalRef: row['external_ref'] as Record<string, unknown>,
    status: row['status'] as EntitlementStatus,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

function mapRole(row: Record<string, unknown>): BusinessRole {
  return {
    id: row['id'] as string,
    code: row['code'] as string,
    name: row['name'] as string,
    description: row['description'] as string | null,
    ownerIdentityId: row['owner_identity_id'] as string,
    riskLevel: row['risk_level'] as RiskLevel,
    requiresSecurityApproval: row['requires_security_approval'] as boolean,
    status: row['status'] as CatalogStatus,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export interface CreateEntitlementInput {
  applicationId: string;
  code: string;
  name: string;
  description?: string | null;
  riskLevel?: RiskLevel;
  isPrivileged?: boolean;
  /** Target-system binding, e.g. {entraGroupObjectId: "..."} — no secrets. */
  externalRef?: Record<string, unknown>;
}

export async function createEntitlement(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: CreateEntitlementInput,
): Promise<Entitlement> {
  assertPermission(ctx, 'entitlement:write');

  return withTransaction(pool, async (client) => {
    const app = await client.query('SELECT status FROM applications WHERE id = $1 FOR UPDATE', [
      input.applicationId,
    ]);
    if (app.rows.length === 0) {
      throw new NotFoundError('application', input.applicationId);
    }
    if (app.rows[0].status === 'RETIRED') {
      throw new InvariantViolation(
        'APPLICATION_RETIRED',
        'entitlements cannot be added to a retired application',
      );
    }
    const {rows} = await client.query(
      `INSERT INTO entitlements
         (application_id, code, name, description, risk_level, is_privileged, external_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        input.applicationId,
        input.code,
        input.name,
        input.description ?? null,
        input.riskLevel ?? 'MEDIUM',
        input.isPrivileged ?? false,
        JSON.stringify(input.externalRef ?? {}),
      ],
    );
    const entitlement = mapEntitlement(rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'entitlement.created',
      entityType: 'entitlement',
      entityId: entitlement.id,
      afterState: entitlement,
    });
    return entitlement;
  });
}

export async function deprecateEntitlement(
  pool: pg.Pool,
  ctx: AuthzContext,
  entitlementId: string,
): Promise<Entitlement> {
  assertPermission(ctx, 'entitlement:write');

  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `UPDATE entitlements SET status = 'DEPRECATED' WHERE id = $1 RETURNING *`,
      [entitlementId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('entitlement', entitlementId);
    }
    const entitlement = mapEntitlement(rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'entitlement.deprecated',
      entityType: 'entitlement',
      entityId: entitlementId,
      afterState: {status: 'DEPRECATED'},
    });
    return entitlement;
  });
}

// ---------------------------------------------------------------------------
// Business roles
// ---------------------------------------------------------------------------

export interface CreateBusinessRoleInput {
  code: string;
  name: string;
  description?: string | null;
  ownerIdentityId: string;
  riskLevel?: RiskLevel;
  requiresSecurityApproval?: boolean;
}

export async function createBusinessRole(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: CreateBusinessRoleInput,
): Promise<BusinessRole> {
  assertPermission(ctx, 'role:write');

  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `INSERT INTO business_roles
         (code, name, description, owner_identity_id, risk_level, requires_security_approval)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.code,
        input.name,
        input.description ?? null,
        input.ownerIdentityId,
        input.riskLevel ?? 'MEDIUM',
        input.requiresSecurityApproval ?? false,
      ],
    );
    const role = mapRole(rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'business_role.created',
      entityType: 'business_role',
      entityId: role.id,
      afterState: role,
    });
    return role;
  });
}

export async function disableBusinessRole(
  pool: pg.Pool,
  ctx: AuthzContext,
  roleId: string,
): Promise<BusinessRole> {
  assertPermission(ctx, 'role:write');

  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `UPDATE business_roles SET status = 'DISABLED' WHERE id = $1 RETURNING *`,
      [roleId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('business_role', roleId);
    }
    const role = mapRole(rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'business_role.disabled',
      entityType: 'business_role',
      entityId: roleId,
      afterState: {status: 'DISABLED'},
    });
    return role;
  });
}

// ---------------------------------------------------------------------------
// Role -> entitlement mappings
// ---------------------------------------------------------------------------

export async function addRoleEntitlement(
  pool: pg.Pool,
  ctx: AuthzContext,
  roleId: string,
  entitlementId: string,
): Promise<void> {
  assertPermission(ctx, 'role:write');

  return withTransaction(pool, async (client) => {
    const role = await client.query('SELECT status FROM business_roles WHERE id = $1 FOR UPDATE', [
      roleId,
    ]);
    if (role.rows.length === 0) {
      throw new NotFoundError('business_role', roleId);
    }
    const entitlement = await client.query('SELECT status FROM entitlements WHERE id = $1', [
      entitlementId,
    ]);
    if (entitlement.rows.length === 0) {
      throw new NotFoundError('entitlement', entitlementId);
    }
    if (entitlement.rows[0].status === 'DEPRECATED') {
      throw new InvariantViolation(
        'ENTITLEMENT_DEPRECATED',
        'deprecated entitlements cannot be mapped into roles',
      );
    }
    if (ctx.actorIdentityId === null) {
      throw new InvariantViolation(
        'HUMAN_ACTOR_REQUIRED',
        'role mappings change effective access for every holder and require a human actor',
      );
    }
    await client.query(
      `INSERT INTO role_entitlements (role_id, entitlement_id, added_by_identity_id)
       VALUES ($1, $2, $3)`,
      [roleId, entitlementId, ctx.actorIdentityId],
    );
    await writeAuditEvent(client, ctx, {
      action: 'role_entitlement.added',
      entityType: 'business_role',
      entityId: roleId,
      afterState: {entitlementId},
    });
  });
}

export async function removeRoleEntitlement(
  pool: pg.Pool,
  ctx: AuthzContext,
  roleId: string,
  entitlementId: string,
): Promise<void> {
  assertPermission(ctx, 'role:write');

  return withTransaction(pool, async (client) => {
    const {rowCount} = await client.query(
      'DELETE FROM role_entitlements WHERE role_id = $1 AND entitlement_id = $2',
      [roleId, entitlementId],
    );
    if (rowCount === 0) {
      throw new NotFoundError('role_entitlement', `${roleId}/${entitlementId}`);
    }
    await writeAuditEvent(client, ctx, {
      action: 'role_entitlement.removed',
      entityType: 'business_role',
      entityId: roleId,
      beforeState: {entitlementId},
    });
  });
}

export async function listRoleEntitlements(
  pool: pg.Pool,
  ctx: AuthzContext,
  roleId: string,
): Promise<Entitlement[]> {
  assertPermission(ctx, 'catalog:read');
  const {rows} = await pool.query(
    `SELECT e.* FROM entitlements e
     JOIN role_entitlements re ON re.entitlement_id = e.id
     WHERE re.role_id = $1 ORDER BY e.code`,
    [roleId],
  );
  return rows.map((r) => mapEntitlement(r as Record<string, unknown>));
}
