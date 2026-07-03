import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Permission} from '../src/index.js';
import {
  addRoleEntitlement,
  changeIdentityStatus,
  createAssignmentRule,
  createBusinessRole,
  createEntitlement,
  createIdentity,
  grantExceptionAccess,
  linkIdentityAccount,
  processLifecycleEvents,
  registerApplication,
  ruleMatchesIdentity,
  submitAccessRequest,
  systemContext,
  updateIdentity,
  userContext,
} from '../src/index.js';
import {createTestDb, fetchAuditEvents, type TestDb} from './setup.js';

let db: TestDb;
let adminId: string;
let appId: string;
let entFinanceId: string;
let entSalesId: string;
let roleFinanceId: string;
let roleSalesId: string;

const FUTURE = new Date('2030-01-01T00:00:00Z');
const ADMIN_PERMS: Permission[] = [
  'identity:read', 'identity:write', 'identity:lifecycle',
  'application:write', 'entitlement:write', 'role:write', 'catalog:read',
  'grant:read', 'grant:write', 'request:read', 'request:submit',
];
const admin = () => userContext(adminId, ADMIN_PERMS);

async function liveRoles(identityId: string): Promise<Array<{role_id: string; status: string}>> {
  const {rows} = await db.pool.query(
    `SELECT role_id, status FROM role_assignments
     WHERE identity_id = $1 AND status IN ('PENDING_PROVISIONING','ACTIVE') ORDER BY created_at`,
    [identityId],
  );
  return rows;
}

beforeAll(async () => {
  db = await createTestDb('iam_svc_lifecycle');
  adminId = (
    await createIdentity(db.pool, systemContext(), {
      identityType: 'EMPLOYEE',
      displayName: 'Lifecycle Admin',
      primaryEmail: 'lifecycle-admin@corp.example.com',
    })
  ).id;
  appId = (
    await registerApplication(db.pool, admin(), {name: 'ERP', ownerIdentityId: adminId})
  ).id;
  entFinanceId = (
    await createEntitlement(db.pool, admin(), {applicationId: appId, code: 'FIN', name: 'Finance access'})
  ).id;
  entSalesId = (
    await createEntitlement(db.pool, admin(), {applicationId: appId, code: 'SALES', name: 'Sales access'})
  ).id;
  roleFinanceId = (
    await createBusinessRole(db.pool, admin(), {code: 'FIN_BASE', name: 'Finance Base', ownerIdentityId: adminId})
  ).id;
  await addRoleEntitlement(db.pool, admin(), roleFinanceId, entFinanceId);
  roleSalesId = (
    await createBusinessRole(db.pool, admin(), {code: 'SALES_BASE', name: 'Sales Base', ownerIdentityId: adminId})
  ).id;
  await addRoleEntitlement(db.pool, admin(), roleSalesId, entSalesId);

  await createAssignmentRule(db.pool, admin(), {
    roleId: roleFinanceId,
    name: 'Finance employees',
    attributeFilter: {department: 'Finance', identityType: 'EMPLOYEE'},
  });
  await createAssignmentRule(db.pool, admin(), {
    roleId: roleSalesId,
    name: 'Sales employees',
    attributeFilter: {department: 'Sales'},
  });
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('rule matching', () => {
  it('matches case-insensitively on known attributes and fails closed otherwise', () => {
    const identity = {identity_type: 'EMPLOYEE', department: 'finance'};
    expect(ruleMatchesIdentity({department: 'Finance'}, identity)).toBe(true);
    expect(ruleMatchesIdentity({department: 'Finance', identityType: 'EMPLOYEE'}, identity)).toBe(true);
    expect(ruleMatchesIdentity({department: 'Sales'}, identity)).toBe(false);
    expect(ruleMatchesIdentity({unknownAttribute: 'x'}, identity)).toBe(false);
    expect(ruleMatchesIdentity({}, identity)).toBe(false);
  });
});

describe('joiner automation', () => {
  it('assigns matching birthright roles when the joiner activates', async () => {
    const joiner = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Nina Newhire',
      primaryEmail: 'nina@corp.example.com',
      department: 'Finance',
    });
    await changeIdentityStatus(db.pool, admin(), joiner.id, 'ACTIVE');

    const result = await processLifecycleEvents(db.pool, systemContext());
    const joinerRun = result.processed.find((p) => p.eventType === 'JOINER');
    expect(joinerRun?.actions.rolesAssigned).toHaveLength(1);

    const roles = await liveRoles(joiner.id);
    expect(roles.map((r) => r.role_id)).toEqual([roleFinanceId]);
    const audit = await fetchAuditEvents(db.pool, joiner.id);
    expect(audit.map((e) => e['action'])).toContain('identity.joiner_processed');

    // Re-running processes nothing: the journal is consumed exactly once.
    const again = await processLifecycleEvents(db.pool, systemContext());
    expect(again.processed).toHaveLength(0);
  });
});

describe('mover automation', () => {
  it('swaps birthright roles when the department changes', async () => {
    const mover = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Mia Mover',
      primaryEmail: 'mia@corp.example.com',
      department: 'Finance',
    });
    await changeIdentityStatus(db.pool, admin(), mover.id, 'ACTIVE');
    await processLifecycleEvents(db.pool, systemContext());
    expect((await liveRoles(mover.id)).map((r) => r.role_id)).toEqual([roleFinanceId]);

    await updateIdentity(db.pool, admin(), mover.id, {department: 'Sales'});
    const result = await processLifecycleEvents(db.pool, systemContext());
    const moverRun = result.processed.find((p) => p.eventType === 'MOVER');
    expect(moverRun?.actions.rolesAssigned).toHaveLength(1);
    expect(moverRun?.actions.rolesRevoked).toHaveLength(1);

    const roles = await liveRoles(mover.id);
    expect(roles.map((r) => r.role_id)).toEqual([roleSalesId]);

    const finance = await db.pool.query(
      `SELECT status, revoked_reason FROM role_assignments WHERE identity_id = $1 AND role_id = $2`,
      [mover.id, roleFinanceId],
    );
    expect(finance.rows[0]).toMatchObject({revoked_reason: 'MOVER'});
  });

  it('does not touch requested or temporary access on a move', async () => {
    const mover = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Max Keeper',
      primaryEmail: 'max@corp.example.com',
      department: 'Finance',
    });
    await changeIdentityStatus(db.pool, admin(), mover.id, 'ACTIVE');
    await processLifecycleEvents(db.pool, systemContext());
    await grantExceptionAccess(db.pool, admin(), {
      identityId: mover.id,
      entitlementId: entSalesId,
      justification: 'cross-team project',
      approvedByIdentityId: adminId,
      expiresAt: FUTURE,
    });

    await updateIdentity(db.pool, admin(), mover.id, {department: 'Sales'});
    await processLifecycleEvents(db.pool, systemContext());

    const exception = await db.pool.query(
      `SELECT status FROM entitlement_assignments
       WHERE identity_id = $1 AND assignment_type = 'EXCEPTION'`,
      [mover.id],
    );
    expect(exception.rows[0].status).toBe('PENDING_PROVISIONING'); // untouched
  });
});

describe('leaver kill-switch', () => {
  it('revokes all access, cancels open requests, and disables accounts on termination', async () => {
    const leaver = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Leo Leaver',
      primaryEmail: 'leo@corp.example.com',
      department: 'Finance',
      managerId: adminId,
    });
    await changeIdentityStatus(db.pool, admin(), leaver.id, 'ACTIVE');
    await processLifecycleEvents(db.pool, systemContext()); // joiner -> birthright role
    await linkIdentityAccount(db.pool, admin(), {
      identityId: leaver.id,
      applicationId: appId,
      accountIdentifier: 'leo@corp.example.com',
    });
    await grantExceptionAccess(db.pool, admin(), {
      identityId: leaver.id,
      entitlementId: entSalesId,
      justification: 'temp project',
      approvedByIdentityId: adminId,
      expiresAt: FUTURE,
    });
    const requester = userContext(leaver.id, ['request:submit']);
    await submitAccessRequest(db.pool, requester, {
      justification: 'more access please',
      items: [{targetType: 'ROLE', roleId: roleSalesId}],
    });

    await changeIdentityStatus(db.pool, admin(), leaver.id, 'TERMINATED');
    const result = await processLifecycleEvents(db.pool, systemContext());
    const leaverRun = result.processed.find((p) => p.eventType === 'LEAVER');
    expect(leaverRun?.actions.rolesRevoked.length).toBeGreaterThanOrEqual(1);
    expect(leaverRun?.actions.grantsRevoked.length).toBeGreaterThanOrEqual(1);
    expect(leaverRun?.actions.requestsCancelled).toHaveLength(1);
    expect(leaverRun?.actions.accountsDisabled).toHaveLength(1);

    const liveAccess = await db.pool.query(
      `SELECT count(*)::int AS n FROM entitlement_assignments
       WHERE identity_id = $1 AND status IN ('PENDING_PROVISIONING','ACTIVE')`,
      [leaver.id],
    );
    expect(liveAccess.rows[0].n).toBe(0);
    const requests = await db.pool.query(
      `SELECT status FROM access_requests WHERE beneficiary_identity_id = $1`,
      [leaver.id],
    );
    expect(requests.rows.every((r) => r.status === 'CANCELLED')).toBe(true);
    const accounts = await db.pool.query(
      `SELECT status FROM identity_accounts WHERE identity_id = $1`,
      [leaver.id],
    );
    expect(accounts.rows[0].status).toBe('DISABLED');

    const audit = await fetchAuditEvents(db.pool, leaver.id);
    expect(audit.map((e) => e['action'])).toContain('identity.leaver_processed');
  });
});
