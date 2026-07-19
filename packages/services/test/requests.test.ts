import {InvariantViolation} from '@iam/domain';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Permission} from '../src/index.js';
import {
  addRoleEntitlement,
  assignRoleToIdentity,
  cancelAccessRequest,
  changeIdentityStatus,
  createBusinessRole,
  createEntitlement,
  createIdentity,
  decideApproval,
  getRequestTrail,
  registerApplication,
  submitAccessRequest,
  systemContext,
  userContext,
} from '../src/index.js';
import {createTestDb, type TestDb} from './setup.js';

let db: TestDb;
let adminId: string;
let managerId: string;
let aliceId: string; // employee, manager = managerId
let appOwnerId: string;
let securityId: string;
let appId: string;
let entViewId: string; // LOW risk
let entAdminId: string; // CRITICAL, privileged
let roleClerkId: string; // maps entView only -> low risk
let roleAdminId: string; // maps entAdmin -> forces security stage

const FUTURE = new Date('2030-01-01T00:00:00Z');
const ADMIN_PERMS: Permission[] = [
  'identity:read',
  'identity:write',
  'identity:lifecycle',
  'application:write',
  'entitlement:write',
  'role:write',
  'grant:read',
  'grant:write',
  'request:read',
];

function admin() {
  return userContext(adminId, ADMIN_PERMS);
}

function as(identityId: string) {
  return userContext(identityId, ['request:submit', 'request:approve', 'request:read']);
}

async function newActiveUser(name: string, managerIdArg?: string): Promise<string> {
  const identity = await createIdentity(db.pool, admin(), {
    identityType: 'EMPLOYEE',
    displayName: name,
    primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}@corp.example.com`,
    managerId: managerIdArg ?? null,
  });
  await changeIdentityStatus(db.pool, admin(), identity.id, 'ACTIVE');
  return identity.id;
}

beforeAll(async () => {
  db = await createTestDb('iam_svc_requests');
  adminId = (
    await createIdentity(db.pool, systemContext(), {
      identityType: 'EMPLOYEE',
      displayName: 'Request Admin',
      primaryEmail: 'request-admin@corp.example.com',
    })
  ).id;
  managerId = await newActiveUser('Mona Manager');
  aliceId = await newActiveUser('Alice Requester', managerId);
  appOwnerId = await newActiveUser('Oscar Owner', managerId);
  securityId = await newActiveUser('Sam Security');

  appId = (
    await registerApplication(db.pool, admin(), {
      name: 'ERP',
      ownerIdentityId: appOwnerId,
      securityOfficerIdentityId: securityId,
    })
  ).id;
  entViewId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'ERP_VIEW',
      name: 'View ERP',
      riskLevel: 'LOW',
    })
  ).id;
  entAdminId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'ERP_ADMIN',
      name: 'Administer ERP',
      riskLevel: 'CRITICAL',
      isPrivileged: true,
    })
  ).id;
  roleClerkId = (
    await createBusinessRole(db.pool, admin(), {
      code: 'ERP_CLERK',
      name: 'ERP Clerk',
      ownerIdentityId: adminId,
      riskLevel: 'LOW',
    })
  ).id;
  await addRoleEntitlement(db.pool, admin(), roleClerkId, entViewId);
  roleAdminId = (
    await createBusinessRole(db.pool, admin(), {
      code: 'ERP_ADMIN_ROLE',
      name: 'ERP Administrator',
      ownerIdentityId: adminId,
      riskLevel: 'HIGH',
    })
  ).id;
  await addRoleEntitlement(db.pool, admin(), roleAdminId, entAdminId);
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('submission and chain computation', () => {
  it('computes manager -> app owner for a low-risk role request', async () => {
    const {request, approvalStages, sodFlags} = await submitAccessRequest(db.pool, as(aliceId), {
      justification: 'need ERP read access for reporting',
      items: [{targetType: 'ROLE', roleId: roleClerkId}],
    });
    expect(request.status).toBe('PENDING_APPROVAL');
    expect(sodFlags).toEqual([]);
    expect(approvalStages).toEqual([
      {stageOrder: 1, stageType: 'MANAGER', approverIdentityId: managerId},
      {stageOrder: 2, stageType: 'APP_OWNER', approverIdentityId: appOwnerId},
    ]);
    // Cleanup for later tests.
    await cancelAccessRequest(db.pool, as(aliceId), request.id);
  });

  it('forces the security stage for privileged/high-risk targets', async () => {
    const {request, approvalStages} = await submitAccessRequest(db.pool, as(aliceId), {
      justification: 'temporary admin duty',
      items: [{targetType: 'ROLE', roleId: roleAdminId, requestedExpiresAt: FUTURE}],
    });
    expect(approvalStages.map((s) => s.stageType)).toEqual(['MANAGER', 'APP_OWNER', 'SECURITY']);
    await cancelAccessRequest(db.pool, as(aliceId), request.id);
  });

  it('requires expiry on direct entitlement (exception) items', async () => {
    await expect(
      submitAccessRequest(db.pool, as(aliceId), {
        justification: 'direct access forever',
        items: [{targetType: 'ENTITLEMENT', entitlementId: entViewId}],
      }),
    ).rejects.toThrowError(/expiry/);
  });

  it('rejects empty justifications and empty item lists', async () => {
    await expect(
      submitAccessRequest(db.pool, as(aliceId), {justification: '  ', items: [{targetType: 'ROLE', roleId: roleClerkId}]}),
    ).rejects.toThrowError(/justification/);
    await expect(
      submitAccessRequest(db.pool, as(aliceId), {justification: 'x', items: []}),
    ).rejects.toThrowError(/at least one item/);
  });
});

describe('approval sequencing and fulfillment', () => {
  it('enforces stage order, then fulfills on the final approval', async () => {
    const {request} = await submitAccessRequest(db.pool, as(aliceId), {
      justification: 'reporting access',
      items: [{targetType: 'ROLE', roleId: roleClerkId}],
    });

    // App owner cannot jump the manager stage.
    await expect(
      decideApproval(db.pool, as(appOwnerId), {requestId: request.id, decision: 'APPROVED'}),
    ).rejects.toThrowError(/earlier approval stages/);

    const first = await decideApproval(db.pool, as(managerId), {
      requestId: request.id,
      decision: 'APPROVED',
      comment: 'fine by me',
    });
    expect(first).toEqual({requestStatus: 'PENDING_APPROVAL', fulfilled: false});

    const final = await decideApproval(db.pool, as(appOwnerId), {
      requestId: request.id,
      decision: 'APPROVED',
    });
    expect(final).toEqual({requestStatus: 'PROVISIONED', fulfilled: true});

    const trail = await getRequestTrail(db.pool, as(aliceId), request.id);
    expect(trail.request.status).toBe('PROVISIONED');
    expect(trail.grants.roleAssignments).toHaveLength(1);
    expect(trail.grants.roleAssignments[0]).toMatchObject({
      identity_id: aliceId,
      role_id: roleClerkId,
      assignment_type: 'REQUESTED',
      granted_via_request_id: request.id,
    });
    expect(trail.grants.entitlementAssignments).toHaveLength(1);
    expect(trail.auditEvents.map((e) => e['action'])).toEqual([
      'access_request.submitted',
      'approval.decided',
      'approval.decided',
      'access_request.approved',
      'access_request.provisioned',
    ]);
  });

  it('rejects the whole request when any stage rejects, granting nothing', async () => {
    const bob = await newActiveUser('Bob Rejected', managerId);
    const {request} = await submitAccessRequest(db.pool, as(bob), {
      justification: 'asking nicely',
      items: [{targetType: 'ROLE', roleId: roleClerkId}],
    });
    const result = await decideApproval(db.pool, as(managerId), {
      requestId: request.id,
      decision: 'REJECTED',
      comment: 'no business need',
    });
    expect(result.requestStatus).toBe('REJECTED');

    const trail = await getRequestTrail(db.pool, as(bob), request.id);
    expect(trail.grants.roleAssignments).toHaveLength(0);
    expect(trail.grants.entitlementAssignments).toHaveLength(0);
    expect(trail.auditEvents.map((e) => e['action'])).toContain('access_request.rejected');
    // Later stages cannot decide a settled request.
    await expect(
      decideApproval(db.pool, as(appOwnerId), {requestId: request.id, decision: 'APPROVED'}),
    ).rejects.toThrowError(/not awaiting approval/);
  });

  it('fulfills direct entitlement items as EXCEPTION grants with a policy exception naming the security approver', async () => {
    const carol = await newActiveUser('Carol Exception', managerId);
    const {request, approvalStages} = await submitAccessRequest(db.pool, as(carol), {
      justification: 'break-glass admin for migration weekend',
      items: [{targetType: 'ENTITLEMENT', entitlementId: entAdminId, requestedExpiresAt: FUTURE}],
    });
    expect(approvalStages.map((s) => s.stageType)).toEqual(['MANAGER', 'APP_OWNER', 'SECURITY']);

    await decideApproval(db.pool, as(managerId), {requestId: request.id, decision: 'APPROVED'});
    await decideApproval(db.pool, as(appOwnerId), {requestId: request.id, decision: 'APPROVED'});
    const final = await decideApproval(db.pool, as(securityId), {
      requestId: request.id,
      decision: 'APPROVED',
    });
    expect(final.fulfilled).toBe(true);

    const trail = await getRequestTrail(db.pool, as(carol), request.id);
    const grant = trail.grants.entitlementAssignments[0]!;
    expect(grant).toMatchObject({assignment_type: 'EXCEPTION', identity_id: carol});
    expect(grant['expires_at']).not.toBeNull();

    const pe = await db.pool.query(
      'SELECT * FROM policy_exceptions WHERE entitlement_assignment_id = $1',
      [grant['id']],
    );
    expect(pe.rows).toHaveLength(1);
    expect(pe.rows[0]).toMatchObject({
      approved_by_identity_id: securityId,
      justification: 'break-glass admin for migration weekend',
    });
  });

  it('refuses deciders who are not approvers on the request', async () => {
    const dave = await newActiveUser('Dave Outsider', managerId);
    const {request} = await submitAccessRequest(db.pool, as(dave), {
      justification: 'access please',
      items: [{targetType: 'ROLE', roleId: roleClerkId}],
    });
    await expect(
      decideApproval(db.pool, as(dave), {requestId: request.id, decision: 'APPROVED'}),
    ).rejects.toThrowError(/no pending approval/);
    await cancelAccessRequest(db.pool, as(dave), request.id);
  });
});

describe('chain edge cases', () => {
  it('collapses duplicate approvers across stages (manager who is also app owner)', async () => {
    const erin = await newActiveUser('Erin Reports To Owner', appOwnerId);
    const {request, approvalStages} = await submitAccessRequest(db.pool, as(erin), {
      justification: 'my manager owns the app',
      items: [{targetType: 'ROLE', roleId: roleClerkId}],
    });
    expect(approvalStages).toEqual([
      {stageOrder: 1, stageType: 'MANAGER', approverIdentityId: appOwnerId},
    ]);
    const final = await decideApproval(db.pool, as(appOwnerId), {
      requestId: request.id,
      decision: 'APPROVED',
    });
    expect(final.fulfilled).toBe(true);
  });

  it('never asks the beneficiary to approve (owner requesting own app access)', async () => {
    const {approvalStages, request} = await submitAccessRequest(db.pool, as(appOwnerId), {
      justification: 'owner needs clerk view too',
      items: [{targetType: 'ROLE', roleId: roleClerkId}],
    });
    // App-owner stage would be the beneficiary — skipped; the owner's own
    // manager remains as the approver.
    expect(approvalStages).toEqual([
      {stageOrder: 1, stageType: 'MANAGER', approverIdentityId: managerId},
    ]);
    await cancelAccessRequest(db.pool, as(appOwnerId), request.id);
  });

  it('fails closed when no eligible approver exists at all', async () => {
    // An owner with no manager requesting access to their own app: the
    // manager stage is empty and the app-owner stage is the beneficiary.
    const soloOwner = await newActiveUser('Solo Owner');
    const soloApp = await registerApplication(db.pool, admin(), {
      name: 'Solo App',
      ownerIdentityId: soloOwner,
    });
    const soloEnt = await createEntitlement(db.pool, admin(), {
      applicationId: soloApp.id,
      code: 'SOLO_VIEW',
      name: 'View solo app',
      riskLevel: 'LOW',
    });
    const soloRole = await createBusinessRole(db.pool, admin(), {
      code: 'SOLO_ROLE',
      name: 'Solo role',
      ownerIdentityId: soloOwner,
    });
    await addRoleEntitlement(db.pool, admin(), soloRole.id, soloEnt.id);
    await expect(
      submitAccessRequest(db.pool, as(soloOwner), {
        justification: 'no one can approve this',
        items: [{targetType: 'ROLE', roleId: soloRole.id}],
      }),
    ).rejects.toThrowError(/no eligible approvers/);
  });

  it('only the requester can cancel', async () => {
    const fred = await newActiveUser('Fred Cancels', managerId);
    const {request} = await submitAccessRequest(db.pool, as(fred), {
      justification: 'changed my mind soon',
      items: [{targetType: 'ROLE', roleId: roleClerkId}],
    });
    await expect(
      cancelAccessRequest(db.pool, as(managerId), request.id),
    ).rejects.toThrowError(/only the requester/);
    await cancelAccessRequest(db.pool, as(fred), request.id);
    const trail = await getRequestTrail(db.pool, as(fred), request.id);
    expect(trail.request.status).toBe('CANCELLED');
    expect(trail.auditEvents.map((e) => e['action'])).toContain('access_request.cancelled');
  });
});

describe('segregation of duties', () => {
  it('blocks BLOCK-severity conflicts with currently-held access', async () => {
    const gina = await newActiveUser('Gina Conflicted', managerId);
    const conflictingRole = await createBusinessRole(db.pool, admin(), {
      code: 'AP_PAYMENTS',
      name: 'AP Payments',
      ownerIdentityId: adminId,
    });
    await assignRoleToIdentity(db.pool, admin(), {
      identityId: gina,
      roleId: conflictingRole.id,
      assignmentType: 'REQUESTED',
    });
    await db.pool.query(
      `INSERT INTO sod_rules
         (name, first_target_type, first_role_id, second_target_type, second_role_id, severity)
       VALUES ('clerk vs payments', 'ROLE', $1, 'ROLE', $2, 'BLOCK')`,
      [roleClerkId, conflictingRole.id],
    );
    await expect(
      submitAccessRequest(db.pool, as(gina), {
        justification: 'I want both sides of the payment flow',
        items: [{targetType: 'ROLE', roleId: roleClerkId}],
      }),
    ).rejects.toThrowError(/segregation-of-duties/);
  });

  it('flags REQUIRE_APPROVAL conflicts and forces the security stage', async () => {
    const hank = await newActiveUser('Hank Flagged', managerId);
    const auditEnt = await createEntitlement(db.pool, admin(), {
      applicationId: appId,
      code: 'ERP_AUDIT_LOG',
      name: 'Read audit log',
      riskLevel: 'LOW',
    });
    await db.pool.query(
      `INSERT INTO sod_rules
         (name, first_target_type, first_entitlement_id, second_target_type, second_entitlement_id, severity)
       VALUES ('view vs audit-log', 'ENTITLEMENT', $1, 'ENTITLEMENT', $2, 'REQUIRE_APPROVAL')`,
      [entViewId, auditEnt.id],
    );
    // Requesting both sides in one request (clerk role expands to ERP_VIEW).
    const {request, approvalStages, sodFlags} = await submitAccessRequest(db.pool, as(hank), {
      justification: 'reporting plus audit-log read',
      items: [
        {targetType: 'ROLE', roleId: roleClerkId},
        {targetType: 'ENTITLEMENT', entitlementId: auditEnt.id, requestedExpiresAt: FUTURE},
      ],
    });
    expect(sodFlags).toHaveLength(1);
    expect(sodFlags[0]).toMatchObject({severity: 'REQUIRE_APPROVAL', ruleName: 'view vs audit-log'});
    expect(approvalStages.map((s) => s.stageType)).toContain('SECURITY');

    const trail = await getRequestTrail(db.pool, as(hank), request.id);
    expect(trail.auditEvents.map((e) => e['action'])).toContain('sod_violation.detected');
    expect(trail.request.sodFlags).toHaveLength(1);
  });
});
