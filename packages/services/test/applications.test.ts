import {InvariantViolation} from '@iam/domain';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  createIdentity,
  getApplication,
  listApplications,
  PermissionDeniedError,
  registerApplication,
  retireApplication,
  systemContext,
  updateApplication,
  userContext,
} from '../src/index.js';
import {createTestDb, fetchAuditEvents, type TestDb} from './setup.js';

let db: TestDb;
let adminId: string;

function admin() {
  return userContext(adminId, ['application:read', 'application:write']);
}

beforeAll(async () => {
  db = await createTestDb('iam_svc_apps');
  const identity = await createIdentity(db.pool, systemContext(), {
    identityType: 'EMPLOYEE',
    displayName: 'App Admin',
    primaryEmail: 'app-admin@corp.example.com',
  });
  adminId = identity.id;
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('registerApplication', () => {
  it('registers an application and audits it', async () => {
    const app = await registerApplication(db.pool, admin(), {
      name: 'SAP',
      ownerIdentityId: adminId,
      criticality: 'CRITICAL',
      connectorConfig: {keyVaultRef: 'kv-sap-connector', tenantId: 'contoso'},
    });
    expect(app.status).toBe('ONBOARDING');
    const audit = await fetchAuditEvents(db.pool, app.id);
    expect(audit.map((e) => e['action'])).toEqual(['application.created']);
  });

  it('rejects secrets in connector_config outright', async () => {
    await expect(
      registerApplication(db.pool, admin(), {
        name: 'Leaky App',
        ownerIdentityId: adminId,
        connectorConfig: {clientSecret: 'super-secret-value'},
      }),
    ).rejects.toThrowError(InvariantViolation);
    const apps = await listApplications(db.pool, admin());
    expect(apps.map((a) => a.name)).not.toContain('Leaky App');
  });

  it('enforces application:write', async () => {
    const readOnly = userContext(adminId, ['application:read']);
    await expect(
      registerApplication(db.pool, readOnly, {name: 'Nope', ownerIdentityId: adminId}),
    ).rejects.toThrowError(PermissionDeniedError);
  });
});

describe('updateApplication', () => {
  it('updates fields and audits before/after of only the changed keys', async () => {
    const app = await registerApplication(db.pool, admin(), {
      name: 'Jira',
      ownerIdentityId: adminId,
    });
    await updateApplication(db.pool, admin(), app.id, {
      criticality: 'HIGH',
      status: 'ACTIVE',
    });
    const audit = await fetchAuditEvents(db.pool, app.id);
    const update = audit.find((e) => e['action'] === 'application.updated');
    expect(update?.['before_state']).toEqual({criticality: 'MEDIUM', status: 'ONBOARDING'});
    expect(update?.['after_state']).toEqual({criticality: 'HIGH', status: 'ACTIVE'});
  });

  it('rejects secret-shaped keys on config updates too', async () => {
    const app = await getApplicationByName('Jira');
    await expect(
      updateApplication(db.pool, admin(), app.id, {
        connectorConfig: {nested: {api_key: 'x'}},
      }),
    ).rejects.toThrowError(/Key Vault/);
  });
});

describe('retireApplication', () => {
  it('retires an application exactly once', async () => {
    const app = await registerApplication(db.pool, admin(), {
      name: 'Legacy CRM',
      ownerIdentityId: adminId,
    });
    const retired = await retireApplication(db.pool, admin(), app.id);
    expect(retired.status).toBe('RETIRED');
    // Idempotent: second call is a no-op with no extra audit event.
    await retireApplication(db.pool, admin(), app.id);
    const audit = await fetchAuditEvents(db.pool, app.id);
    expect(audit.filter((e) => e['action'] === 'application.retired')).toHaveLength(1);
  });
});

async function getApplicationByName(name: string) {
  const apps = await listApplications(db.pool, admin());
  const app = apps.find((a) => a.name === name);
  if (!app) throw new Error(`fixture app ${name} missing`);
  return getApplication(db.pool, admin(), app.id);
}
