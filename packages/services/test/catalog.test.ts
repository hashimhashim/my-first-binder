import {InvariantViolation} from '@iam/domain';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  addRoleEntitlement,
  createBusinessRole,
  createEntitlement,
  createIdentity,
  deprecateEntitlement,
  disableBusinessRole,
  listRoleEntitlements,
  NotFoundError,
  registerApplication,
  removeRoleEntitlement,
  retireApplication,
  systemContext,
  userContext,
} from '../src/index.js';
import {createTestDb, fetchAuditEvents, type TestDb} from './setup.js';

let db: TestDb;
let adminId: string;
let appId: string;

function admin() {
  return userContext(adminId, [
    'application:write',
    'entitlement:write',
    'role:write',
    'catalog:read',
  ]);
}

beforeAll(async () => {
  db = await createTestDb('iam_svc_catalog');
  const identity = await createIdentity(db.pool, systemContext(), {
    identityType: 'EMPLOYEE',
    displayName: 'Catalog Admin',
    primaryEmail: 'catalog-admin@corp.example.com',
  });
  adminId = identity.id;
  const app = await registerApplication(db.pool, admin(), {
    name: 'Finance System',
    ownerIdentityId: adminId,
  });
  appId = app.id;
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('entitlements', () => {
  it('creates and audits an entitlement with target-system binding', async () => {
    const ent = await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'AP_INVOICE_APPROVE',
      name: 'Approve invoices',
      riskLevel: 'HIGH',
      externalRef: {entraGroupObjectId: 'aaaa-bbbb'},
    });
    const audit = await fetchAuditEvents(db.pool, ent.id);
    expect(audit.map((e) => e['action'])).toEqual(['entitlement.created']);
  });

  it('refuses entitlements on retired applications', async () => {
    const dead = await registerApplication(db.pool, admin(), {
      name: 'Dead App',
      ownerIdentityId: adminId,
    });
    await retireApplication(db.pool, admin(), dead.id);
    await expect(
      createEntitlement(db.pool, admin(), {
        applicationId: dead.id,
        code: 'X',
        name: 'X',
      }),
    ).rejects.toThrowError(/retired/);
  });
});

describe('business roles and mappings', () => {
  it('maps entitlements into roles, audited, and lists them', async () => {
    const role = await createBusinessRole(db.pool, admin(), {
      code: 'FIN_CLERK',
      name: 'Finance Clerk',
      ownerIdentityId: adminId,
    });
    const ent = await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'AP_INVOICE_VIEW',
      name: 'View invoices',
    });
    await addRoleEntitlement(db.pool, admin(), role.id, ent.id);

    const mapped = await listRoleEntitlements(db.pool, admin(), role.id);
    expect(mapped.map((e) => e.code)).toEqual(['AP_INVOICE_VIEW']);

    await removeRoleEntitlement(db.pool, admin(), role.id, ent.id);
    expect(await listRoleEntitlements(db.pool, admin(), role.id)).toEqual([]);

    const audit = await fetchAuditEvents(db.pool, role.id);
    expect(audit.map((e) => e['action'])).toEqual([
      'business_role.created',
      'role_entitlement.added',
      'role_entitlement.removed',
    ]);
  });

  it('refuses mapping deprecated entitlements', async () => {
    const role = await createBusinessRole(db.pool, admin(), {
      code: 'FIN_AUDITOR',
      name: 'Finance Auditor',
      ownerIdentityId: adminId,
    });
    const ent = await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'LEGACY_REPORT',
      name: 'Legacy report',
    });
    await deprecateEntitlement(db.pool, admin(), ent.id);
    await expect(addRoleEntitlement(db.pool, admin(), role.id, ent.id)).rejects.toThrowError(
      /deprecated/,
    );
  });

  it('requires a human actor for mapping changes', async () => {
    const role = await createBusinessRole(db.pool, admin(), {
      code: 'FIN_MGR',
      name: 'Finance Manager',
      ownerIdentityId: adminId,
    });
    const ent = await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'AP_PAYMENT_RELEASE',
      name: 'Release payments',
      riskLevel: 'CRITICAL',
    });
    await expect(
      addRoleEntitlement(db.pool, systemContext(), role.id, ent.id),
    ).rejects.toThrowError(InvariantViolation);
  });

  it('disables roles and 404s on unknown mappings', async () => {
    const role = await createBusinessRole(db.pool, admin(), {
      code: 'TO_DISABLE',
      name: 'Disposable',
      ownerIdentityId: adminId,
    });
    const disabled = await disableBusinessRole(db.pool, admin(), role.id);
    expect(disabled.status).toBe('DISABLED');
    await expect(
      removeRoleEntitlement(db.pool, admin(), role.id, crypto.randomUUID()),
    ).rejects.toThrowError(NotFoundError);
  });
});
