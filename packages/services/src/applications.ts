/**
 * Application registry service: onboarding, updates, and retirement of the
 * applications access can be requested for.
 *
 * connector_config is validated to contain no secret-shaped keys at all —
 * secrets belong in Key Vault, the config may only carry references.
 */

import {
  findSecretShapedKeys,
  InvariantViolation,
  type Application,
  type ApplicationStatus,
  type ConnectorType,
  type Criticality,
  type FulfillmentMode,
} from '@iam/domain';
import type pg from 'pg';
import {writeAuditEvent} from './audit.js';
import {assertPermission, type AuthzContext} from './context.js';
import {NotFoundError} from './identities.js';
import {withTransaction} from './tx.js';

function mapApplication(row: Record<string, unknown>): Application {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string | null,
    ownerIdentityId: row['owner_identity_id'] as string,
    securityOfficerIdentityId: row['security_officer_identity_id'] as string | null,
    connectorType: row['connector_type'] as ConnectorType,
    fulfillmentMode: row['fulfillment_mode'] as FulfillmentMode,
    criticality: row['criticality'] as Criticality,
    status: row['status'] as ApplicationStatus,
    connectorConfig: row['connector_config'] as Record<string, unknown>,
    createdAt: row['created_at'] as Date,
    updatedAt: row['updated_at'] as Date,
  };
}

function assertNoSecretsInConfig(config: Record<string, unknown>): void {
  const secretKeys = findSecretShapedKeys(config);
  if (secretKeys.length > 0) {
    throw new InvariantViolation(
      'SECRETS_IN_CONFIG',
      `connector_config must not contain secrets; use Key Vault references. Offending keys: ${secretKeys.join(', ')}`,
    );
  }
}

export interface RegisterApplicationInput {
  name: string;
  description?: string | null;
  ownerIdentityId: string;
  securityOfficerIdentityId?: string | null;
  connectorType?: ConnectorType;
  fulfillmentMode?: FulfillmentMode;
  criticality?: Criticality;
  connectorConfig?: Record<string, unknown>;
}

export async function registerApplication(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: RegisterApplicationInput,
): Promise<Application> {
  assertPermission(ctx, 'application:write');
  const connectorConfig = input.connectorConfig ?? {};
  assertNoSecretsInConfig(connectorConfig);

  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `INSERT INTO applications
         (name, description, owner_identity_id, security_officer_identity_id,
          connector_type, fulfillment_mode, criticality, connector_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        input.name,
        input.description ?? null,
        input.ownerIdentityId,
        input.securityOfficerIdentityId ?? null,
        input.connectorType ?? 'MANUAL',
        input.fulfillmentMode ?? 'MANUAL',
        input.criticality ?? 'MEDIUM',
        JSON.stringify(connectorConfig),
      ],
    );
    const application = mapApplication(rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'application.created',
      entityType: 'application',
      entityId: application.id,
      afterState: application,
    });
    return application;
  });
}

const UPDATABLE_COLUMNS: Record<string, string> = {
  description: 'description',
  ownerIdentityId: 'owner_identity_id',
  securityOfficerIdentityId: 'security_officer_identity_id',
  connectorType: 'connector_type',
  fulfillmentMode: 'fulfillment_mode',
  criticality: 'criticality',
  status: 'status',
  connectorConfig: 'connector_config',
};

export interface UpdateApplicationInput {
  description?: string | null;
  ownerIdentityId?: string;
  securityOfficerIdentityId?: string | null;
  connectorType?: ConnectorType;
  fulfillmentMode?: FulfillmentMode;
  criticality?: Criticality;
  status?: ApplicationStatus;
  connectorConfig?: Record<string, unknown>;
}

export async function updateApplication(
  pool: pg.Pool,
  ctx: AuthzContext,
  applicationId: string,
  input: UpdateApplicationInput,
): Promise<Application> {
  assertPermission(ctx, 'application:write');
  if (input.connectorConfig !== undefined) {
    assertNoSecretsInConfig(input.connectorConfig);
  }

  return withTransaction(pool, async (client) => {
    const existing = await selectApplicationForUpdate(client, applicationId);

    const entries = Object.entries(input).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return existing;
    }
    const setClauses = entries.map(([key], i) => `${UPDATABLE_COLUMNS[key]} = $${i + 2}`);
    const params = entries.map(([key, value]) =>
      key === 'connectorConfig' ? JSON.stringify(value) : value,
    );
    const {rows} = await client.query(
      `UPDATE applications SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      [applicationId, ...params],
    );
    const updated = mapApplication(rows[0] as Record<string, unknown>);

    const changedKeys = entries.map(([key]) => key) as (keyof Application)[];
    await writeAuditEvent(client, ctx, {
      action: 'application.updated',
      entityType: 'application',
      entityId: applicationId,
      beforeState: pick(existing, changedKeys),
      afterState: pick(updated, changedKeys),
    });
    return updated;
  });
}

export async function retireApplication(
  pool: pg.Pool,
  ctx: AuthzContext,
  applicationId: string,
): Promise<Application> {
  assertPermission(ctx, 'application:write');

  return withTransaction(pool, async (client) => {
    const existing = await selectApplicationForUpdate(client, applicationId);
    if (existing.status === 'RETIRED') {
      return existing;
    }
    const {rows} = await client.query(
      `UPDATE applications SET status = 'RETIRED' WHERE id = $1 RETURNING *`,
      [applicationId],
    );
    const updated = mapApplication(rows[0] as Record<string, unknown>);
    await writeAuditEvent(client, ctx, {
      action: 'application.retired',
      entityType: 'application',
      entityId: applicationId,
      beforeState: {status: existing.status},
      afterState: {status: 'RETIRED'},
    });
    return updated;
  });
}

export async function getApplication(
  pool: pg.Pool,
  ctx: AuthzContext,
  applicationId: string,
): Promise<Application> {
  assertPermission(ctx, 'application:read');
  const {rows} = await pool.query('SELECT * FROM applications WHERE id = $1', [applicationId]);
  if (rows.length === 0) {
    throw new NotFoundError('application', applicationId);
  }
  return mapApplication(rows[0] as Record<string, unknown>);
}

export async function listApplications(
  pool: pg.Pool,
  ctx: AuthzContext,
  filter: {status?: ApplicationStatus} = {},
): Promise<Application[]> {
  assertPermission(ctx, 'application:read');
  const where = filter.status !== undefined ? 'WHERE status = $1' : '';
  const params = filter.status !== undefined ? [filter.status] : [];
  const {rows} = await pool.query(`SELECT * FROM applications ${where} ORDER BY name`, params);
  return rows.map((r) => mapApplication(r as Record<string, unknown>));
}

function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]])) as Partial<T>;
}

async function selectApplicationForUpdate(
  client: pg.ClientBase,
  applicationId: string,
): Promise<Application> {
  const {rows} = await client.query('SELECT * FROM applications WHERE id = $1 FOR UPDATE', [
    applicationId,
  ]);
  if (rows.length === 0) {
    throw new NotFoundError('application', applicationId);
  }
  return mapApplication(rows[0] as Record<string, unknown>);
}
