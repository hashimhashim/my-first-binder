import {InvariantViolation} from '@iam/domain';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  activateGrant,
  addRoleEntitlement,
  assignRoleToIdentity,
  changeIdentityStatus,
  completeEntitlementRevocation,
  createBusinessRole,
  createEntitlement,
  createIdentity,
  deprecateEntitlement,
  disableBusinessRole,
  grantExceptionAccess,
  grantTemporaryAccess,
  listIdentityAccess,
  registerApplication,
  requestRoleRevocation,
  sweepExpiredGrants,
  systemContext,
  userContext,
} from '../src/index.js';
import {createTestDb, fetchAuditEvents, type TestDb} from './setup.js';

let db: TestDb;
let adminId: string;
let securityId: string;
let appId: string;
let entViewId: string;
let entApproveId: string;
let roleClerkId: string;

const FUTURE = new Date('2030-01-01T00:00:00Z');

function admin() {
  return userContext(adminId, [
    'identity:read',
    'identity:write',
    'identity:lifecycle',
    'application:write',
    'entitlement:write',
    'role:write',
    'catalog:read',
    'grant:read',
    'grant:write',
  ]);
}

async function newActiveUser(name: string): Promise<string> {
  const identity = await createIdentity(db.pool, admin(), {
    identityType: 'EMPLOYEE',
    displayName: name,
    primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}@corp.example.com`,
  });
  await changeIdentityStatus(db.pool, admin(), identity.id, 'ACTIVE');
  return identity.id;
}

beforeAll(async () => {
  db = await createTestDb('iam_svc_grants');
  adminId = (
    await createIdentity(db.pool, systemContext(), {
      identityType: 'EMPLOYEE',
      displayName: 'Grant Admin',
      primaryEmail: 'grant-admin@corp.example.com',
    })
  ).id;
  securityId = await newActiveUser('Security Officer');

  const app = await registerApplication(db.pool, admin(), {
    name: 'ERP',
    ownerIdentityId: adminId,
  });
  appId = app.id;
  entViewId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'ERP_VIEW',
      name: 'View ERP',
    })
  ).id;
  entApproveId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'ERP_APPROVE',
      name: 'Approve in ERP',
      riskLevel: 'HIGH',
    })
  ).id;
  roleClerkId = (
    await createBusinessRole(db.pool, admin(), {
      code: 'ERP_CLERK',
      name: 'ERP Clerk',
      ownerIdentityId: adminId,
    })
  ).id;
  await addRoleEntitlement(db.pool, admin(), roleClerkId, entViewId);
  await addRoleEntitlement(db.pool, admin(), roleClerkId, entApproveId);
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('role assignment with expansion', () => {
  it('expands a role into ROLE_DERIVED grants, all audited', async () => {
    const userId = await newActiveUser('Alice Clerk');
    const result = await assignRoleToIdentity(db.pool, admin(), {
      identityId: userId,
      roleId: roleClerkId,
      assignmentType: 'BIRTHRIGHT',
    });
    expect(result.entitlementAssignments).toHaveLength(2);
    expect(result.skippedEntitlementIds).toEqual([]);
    for (const grant of result.entitlementAssignments) {
      expect(grant.assignmentType).toBe('ROLE_DERIVED');
      expect(grant.sourceRoleAssignmentId).toBe(result.roleAssignment.id);
      expect(grant.status).toBe('PENDING_PROVISIONING');
      const audit = await fetchAuditEvents(db.pool, grant.id);
      expect(audit.map((e) => e['action'])).toEqual(['grant.created']);
    }
  });

  it('skips entitlements the identity already holds live', async () => {
    const userId = await newActiveUser('Bob Holder');
    await grantTemporaryAccess(db.pool, admin(), {
      identityId: userId,
      entitlementId: entViewId,
      expiresAt: FUTURE,
    });
    const result = await assignRoleToIdentity(db.pool, admin(), {
      identityId: userId,
      roleId: roleClerkId,
      assignmentType: 'REQUESTED',
    });
    expect(result.skippedEntitlementIds).toEqual([entViewId]);
    expect(result.entitlementAssignments.map((g) => g.entitlementId)).toEqual([entApproveId]);
  });

  it('requires expiry for TEMPORARY role assignments and propagates it to derived grants', async () => {
    const userId = await newActiveUser('Cara Temp');
    await expect(
      assignRoleToIdentity(db.pool, admin(), {
        identityId: userId,
        roleId: roleClerkId,
        assignmentType: 'TEMPORARY',
      }),
    ).rejects.toThrowError(/expiry/);

    const result = await assignRoleToIdentity(db.pool, admin(), {
      identityId: userId,
      roleId: roleClerkId,
      assignmentType: 'TEMPORARY',
      expiresAt: FUTURE,
    });
    expect(result.roleAssignment.expiresAt?.toISOString()).toBe(FUTURE.toISOString());
    for (const grant of result.entitlementAssignments) {
      expect(grant.expiresAt?.toISOString()).toBe(FUTURE.toISOString());
    }
  });

  it('refuses disabled roles', async () => {
    const disabledRole = await createBusinessRole(db.pool, admin(), {
      code: 'GONE',
      name: 'Disabled role',
      ownerIdentityId: adminId,
    });
    await disableBusinessRole(db.pool, admin(), disabledRole.id);
    const userId = await newActiveUser('Dan Denied');
    await expect(
      assignRoleToIdentity(db.pool, admin(), {
        identityId: userId,
        roleId: disabledRole.id,
        assignmentType: 'REQUESTED',
      }),
    ).rejects.toThrowError(/disabled/);
  });
});

describe('temporary and exception access', () => {
  it('grants temporary access only with a future expiry', async () => {
    const userId = await newActiveUser('Eve Temp');
    await expect(
      grantTemporaryAccess(db.pool, admin(), {
        identityId: userId,
        entitlementId: entViewId,
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      }),
    ).rejects.toThrowError(/future|after startsAt/);
    const grant = await grantTemporaryAccess(db.pool, admin(), {
      identityId: userId,
      entitlementId: entViewId,
      expiresAt: FUTURE,
    });
    expect(grant.assignmentType).toBe('TEMPORARY');
    expect(grant.expiresAt).not.toBeNull();
  });

  it('creates exception access with a policy exception record, audited end to end', async () => {
    const userId = await newActiveUser('Frank Exception');
    const {assignment, policyExceptionId} = await grantExceptionAccess(db.pool, admin(), {
      identityId: userId,
      entitlementId: entApproveId,
      justification: 'quarter-close coverage while approver on leave',
      approvedByIdentityId: securityId,
      expiresAt: FUTURE,
    });
    expect(assignment.assignmentType).toBe('EXCEPTION');

    const grantAudit = await fetchAuditEvents(db.pool, assignment.id);
    expect(grantAudit.map((e) => e['action'])).toEqual(['grant.created']);
    const peAudit = await fetchAuditEvents(db.pool, policyExceptionId);
    expect(peAudit.map((e) => e['action'])).toEqual(['policy_exception.created']);
  });

  it('blocks self-approved exceptions and empty justifications', async () => {
    const userId = await newActiveUser('Grace Self');
    await expect(
      grantExceptionAccess(db.pool, admin(), {
        identityId: userId,
        entitlementId: entApproveId,
        justification: 'I approve myself',
        approvedByIdentityId: userId,
        expiresAt: FUTURE,
      }),
    ).rejects.toThrowError(/cannot approve/);
    await expect(
      grantExceptionAccess(db.pool, admin(), {
        identityId: userId,
        entitlementId: entApproveId,
        justification: '   ',
        approvedByIdentityId: securityId,
        expiresAt: FUTURE,
      }),
    ).rejects.toThrowError(/justification/);
  });

  it('refuses access for terminated identities and deprecated entitlements', async () => {
    const goneId = await newActiveUser('Henry Gone');
    await changeIdentityStatus(db.pool, admin(), goneId, 'TERMINATED');
    await expect(
      grantTemporaryAccess(db.pool, admin(), {
        identityId: goneId,
        entitlementId: entViewId,
        expiresAt: FUTURE,
      }),
    ).rejects.toThrowError(/cannot receive new access/);

    const okId = await newActiveUser('Iris Ok');
    const deadEnt = await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'DEAD',
      name: 'Dead entitlement',
    });
    await deprecateEntitlement(db.pool, admin(), deadEnt.id);
    await expect(
      grantTemporaryAccess(db.pool, admin(), {
        identityId: okId,
        entitlementId: deadEnt.id,
        expiresAt: FUTURE,
      }),
    ).rejects.toThrowError(InvariantViolation);
  });
});

describe('revocation', () => {
  it('cascades role revocation to derived grants and completes with evidence', async () => {
    const userId = await newActiveUser('Judy Leaver');
    const assigned = await assignRoleToIdentity(db.pool, admin(), {
      identityId: userId,
      roleId: roleClerkId,
      assignmentType: 'BIRTHRIGHT',
    });
    // Simulate provisioning completion so grants are ACTIVE.
    await activateGrant(db.pool, admin(), 'role_assignments', assigned.roleAssignment.id);
    for (const g of assigned.entitlementAssignments) {
      await activateGrant(db.pool, admin(), 'entitlement_assignments', g.id);
    }

    const revocation = await requestRoleRevocation(
      db.pool,
      admin(),
      assigned.roleAssignment.id,
      'LEAVER',
    );
    expect(revocation.pendingRevocation).toHaveLength(3); // role + 2 derived
    expect(revocation.cancelled).toHaveLength(0);

    // Deprovisioning jobs complete each entitlement revocation.
    for (const g of assigned.entitlementAssignments) {
      await completeEntitlementRevocation(db.pool, admin(), g.id, 'LEAVER');
      const audit = await fetchAuditEvents(db.pool, g.id);
      expect(audit.map((e) => e['action'])).toEqual([
        'grant.created',
        'grant.activated',
        'grant.revocation_requested',
        'grant.revoked',
      ]);
    }

    const access = await listIdentityAccess(db.pool, admin(), userId);
    expect(access.entitlements).toHaveLength(0);
  });

  it('cancels not-yet-provisioned grants immediately', async () => {
    const userId = await newActiveUser('Kyle Cancelled');
    const assigned = await assignRoleToIdentity(db.pool, admin(), {
      identityId: userId,
      roleId: roleClerkId,
      assignmentType: 'REQUESTED',
    });
    const revocation = await requestRoleRevocation(
      db.pool,
      admin(),
      assigned.roleAssignment.id,
      'MANUAL',
    );
    expect(revocation.cancelled).toHaveLength(3);
    expect(revocation.pendingRevocation).toHaveLength(0);
  });
});

describe('expiry sweep', () => {
  it('pushes every expired live grant into the revocation pipeline with reason EXPIRY', async () => {
    const userId = await newActiveUser('Lena Expiring');
    const expiry = new Date(Date.now() + 60_000);
    const assigned = await assignRoleToIdentity(db.pool, admin(), {
      identityId: userId,
      roleId: roleClerkId,
      assignmentType: 'TEMPORARY',
      expiresAt: expiry,
    });
    await activateGrant(db.pool, admin(), 'role_assignments', assigned.roleAssignment.id);
    for (const g of assigned.entitlementAssignments) {
      await activateGrant(db.pool, admin(), 'entitlement_assignments', g.id);
    }

    // Sweep "as of" a time after the expiry.
    const swept = await sweepExpiredGrants(db.pool, systemContext(), new Date(expiry.getTime() + 1000));
    expect(swept.roleAssignments.pendingRevocation).toContain(assigned.roleAssignment.id);
    for (const g of assigned.entitlementAssignments) {
      expect(swept.entitlementAssignments.pendingRevocation).toContain(g.id);
      const audit = await fetchAuditEvents(db.pool, g.id);
      expect(audit.at(-1)).toMatchObject({action: 'grant.revocation_requested'});
    }

    // Sweeping again finds nothing (idempotent).
    const again = await sweepExpiredGrants(db.pool, systemContext(), new Date(expiry.getTime() + 1000));
    expect(again.roleAssignments.pendingRevocation).toHaveLength(0);
    expect(again.entitlementAssignments.pendingRevocation).toHaveLength(0);
  });
});
