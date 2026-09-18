import {InvariantViolation} from '@iam/domain';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {ConnectorJob, ConnectorOutcome, Permission} from '../src/index.js';
import {
  addRoleEntitlement,
  assignRoleToIdentity,
  cancelProvisioningJob,
  changeIdentityStatus,
  confirmManualFulfillment,
  ConnectorRegistry,
  createBusinessRole,
  createEntitlement,
  createIdentity,
  enqueueProvisioningJobs,
  grantTemporaryAccess,
  listManualQueue,
  registerApplication,
  requestRoleRevocation,
  runProvisioningWorker,
  systemContext,
  userContext,
} from '../src/index.js';
import {createTestDb, fetchAuditEvents, type TestDb} from './setup.js';

let db: TestDb;
let adminId: string;
let autoAppId: string;
let manualEntId: string;
let entAId: string;
let entBId: string;
let roleId: string;

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
  'provisioning:read',
  'provisioning:write',
  'provisioning:confirm',
];

function admin() {
  return userContext(adminId, ADMIN_PERMS);
}

class FakeConnector {
  readonly type = 'ENTRA_GRAPH' as const;
  calls: ConnectorJob[] = [];
  handler: (job: ConnectorJob) => Promise<ConnectorOutcome> | ConnectorOutcome = () => ({ok: true});

  async execute(job: ConnectorJob): Promise<ConnectorOutcome> {
    this.calls.push(job);
    return this.handler(job);
  }
}

const fake = new FakeConnector();
const registry = new ConnectorRegistry().register(fake);

async function newActiveUser(name: string): Promise<string> {
  const identity = await createIdentity(db.pool, admin(), {
    identityType: 'EMPLOYEE',
    displayName: name,
    primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}@corp.example.com`,
  });
  await changeIdentityStatus(db.pool, admin(), identity.id, 'ACTIVE');
  return identity.id;
}

async function grantStatus(id: string): Promise<string> {
  const {rows} = await db.pool.query('SELECT status FROM entitlement_assignments WHERE id = $1', [id]);
  return rows[0].status as string;
}

async function roleAssignmentStatus(id: string): Promise<string> {
  const {rows} = await db.pool.query('SELECT status FROM role_assignments WHERE id = $1', [id]);
  return rows[0].status as string;
}

beforeAll(async () => {
  db = await createTestDb('iam_svc_prov');
  adminId = (
    await createIdentity(db.pool, systemContext(), {
      identityType: 'EMPLOYEE',
      displayName: 'Prov Admin',
      primaryEmail: 'prov-admin@corp.example.com',
    })
  ).id;

  autoAppId = (
    await registerApplication(db.pool, admin(), {
      name: 'Entra-backed App',
      ownerIdentityId: adminId,
      connectorType: 'ENTRA_GRAPH',
      fulfillmentMode: 'AUTOMATED',
    })
  ).id;
  const manualAppId = (
    await registerApplication(db.pool, admin(), {
      name: 'Manual App',
      ownerIdentityId: adminId,
      connectorType: 'MANUAL',
      fulfillmentMode: 'MANUAL',
    })
  ).id;

  entAId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: autoAppId,
      code: 'GROUP_A',
      name: 'Group A',
      externalRef: {entraGroupObjectId: 'group-a'},
    })
  ).id;
  entBId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: autoAppId,
      code: 'GROUP_B',
      name: 'Group B',
      externalRef: {entraGroupObjectId: 'group-b'},
    })
  ).id;
  manualEntId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: manualAppId,
      code: 'MAINFRAME_ROLE',
      name: 'Mainframe role',
    })
  ).id;

  roleId = (
    await createBusinessRole(db.pool, admin(), {
      code: 'APP_USER',
      name: 'App User',
      ownerIdentityId: adminId,
    })
  ).id;
  await addRoleEntitlement(db.pool, admin(), roleId, entAId);
  await addRoleEntitlement(db.pool, admin(), roleId, entBId);
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('grant provisioning end to end', () => {
  it('enqueues idempotently, executes via connector, activates grants and settles the role', async () => {
    fake.handler = () => ({ok: true});
    const userId = await newActiveUser('Paula Provisioned');
    const assigned = await assignRoleToIdentity(db.pool, admin(), {
      identityId: userId,
      roleId,
      assignmentType: 'BIRTHRIGHT',
    });

    const first = await enqueueProvisioningJobs(db.pool, systemContext());
    expect(first.grantJobIds).toHaveLength(2);
    // Re-running the sweep creates nothing new (deterministic idempotency keys).
    const second = await enqueueProvisioningJobs(db.pool, systemContext());
    expect(second.grantJobIds).toHaveLength(0);

    const run = await runProvisioningWorker(db.pool, systemContext(), registry);
    expect(run.completed).toHaveLength(2);
    expect(fake.calls.map((c) => c.jobType)).toEqual(['GRANT', 'GRANT']);
    // Payloads carry target binding, never secrets.
    expect(fake.calls[0]!.payload).toMatchObject({application: 'Entra-backed App'});

    for (const g of assigned.entitlementAssignments) {
      expect(await grantStatus(g.id)).toBe('ACTIVE');
    }
    expect(await roleAssignmentStatus(assigned.roleAssignment.id)).toBe('ACTIVE');

    const jobAudit = await fetchAuditEvents(db.pool, first.grantJobIds[0]!);
    expect(jobAudit.map((e) => e['action'])).toEqual([
      'provisioning_job.queued',
      'provisioning_job.completed',
    ]);

    // Running the worker again does nothing — completion is terminal.
    fake.calls = [];
    const rerun = await runProvisioningWorker(db.pool, systemContext(), registry);
    expect(rerun.completed).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('retries failures with exponential backoff and succeeds on a later run', async () => {
    let failures = 2;
    fake.handler = () => {
      if (failures > 0) {
        failures -= 1;
        return {ok: false, error: 'Graph 503', retryable: true};
      }
      return {ok: true};
    };
    const userId = await newActiveUser('Rita Retry');
    const grant = await grantTemporaryAccess(db.pool, admin(), {
      identityId: userId,
      entitlementId: entAId,
      expiresAt: FUTURE,
    });
    const {grantJobIds} = await enqueueProvisioningJobs(db.pool, systemContext());
    const jobId = grantJobIds[0]!;

    const t0 = new Date();
    const run1 = await runProvisioningWorker(db.pool, systemContext(), registry, {
      now: t0,
      backoffBaseMs: 1000,
    });
    expect(run1.failed).toEqual([jobId]);

    // Not due yet: backoff pushed scheduled_for into the future.
    const runEarly = await runProvisioningWorker(db.pool, systemContext(), registry, {now: t0});
    expect(runEarly.failed).toHaveLength(0);
    expect(runEarly.completed).toHaveLength(0);

    const run2 = await runProvisioningWorker(db.pool, systemContext(), registry, {
      now: new Date(t0.getTime() + 60_000),
      backoffBaseMs: 1000,
    });
    expect(run2.failed).toEqual([jobId]);
    const run3 = await runProvisioningWorker(db.pool, systemContext(), registry, {
      now: new Date(t0.getTime() + 600_000),
      backoffBaseMs: 1000,
    });
    expect(run3.completed).toEqual([jobId]);
    expect(await grantStatus(grant.id)).toBe('ACTIVE');

    const {rows} = await db.pool.query('SELECT attempt_count FROM provisioning_jobs WHERE id = $1', [jobId]);
    expect(rows[0].attempt_count).toBe(2);
    const audit = await fetchAuditEvents(db.pool, jobId);
    expect(audit.map((e) => e['action'])).toEqual([
      'provisioning_job.queued',
      'provisioning_job.failed',
      'provisioning_job.failed',
      'provisioning_job.completed',
    ]);
  });

  it('routes exhausted and non-retryable failures to the manual queue', async () => {
    fake.handler = () => ({ok: false, error: 'target gone', retryable: false});
    const userId = await newActiveUser('Nora Nonretryable');
    await grantTemporaryAccess(db.pool, admin(), {
      identityId: userId,
      entitlementId: entBId,
      expiresAt: FUTURE,
    });
    const {grantJobIds} = await enqueueProvisioningJobs(db.pool, systemContext());
    const run = await runProvisioningWorker(db.pool, systemContext(), registry);
    expect(run.manualRouted).toEqual(grantJobIds);
    const audit = await fetchAuditEvents(db.pool, grantJobIds[0]!);
    expect(audit.at(-1)).toMatchObject({action: 'provisioning_job.manual_routed'});
    // Clean up: cancel so it doesn't linger in later manual-queue assertions.
    await cancelProvisioningJob(db.pool, admin(), grantJobIds[0]!, 'test cleanup');
  });
});

describe('manual fulfillment', () => {
  it('routes MANUAL-connector jobs to the queue and requires an attributed human confirmation', async () => {
    const userId = await newActiveUser('Manny Manual');
    const grant = await grantTemporaryAccess(db.pool, admin(), {
      identityId: userId,
      entitlementId: manualEntId,
      expiresAt: FUTURE,
    });
    const {grantJobIds} = await enqueueProvisioningJobs(db.pool, systemContext());
    const run = await runProvisioningWorker(db.pool, systemContext(), registry);
    expect(run.manualRouted).toEqual(grantJobIds);

    const queue = await listManualQueue(db.pool, admin());
    expect(queue.map((j) => j['id'])).toContain(grantJobIds[0]);

    // System actors cannot confirm manual work — a person must attest.
    await expect(
      confirmManualFulfillment(db.pool, systemContext(), grantJobIds[0]!),
    ).rejects.toThrowError(InvariantViolation);

    await confirmManualFulfillment(db.pool, admin(), grantJobIds[0]!);
    expect(await grantStatus(grant.id)).toBe('ACTIVE');
    const {rows} = await db.pool.query('SELECT * FROM provisioning_jobs WHERE id = $1', [grantJobIds[0]]);
    expect(rows[0]).toMatchObject({
      status: 'MANUAL_CONFIRMED',
      manual_confirmed_by_identity_id: adminId,
    });
    expect(rows[0].manual_confirmed_at).not.toBeNull();

    // Double confirmation is rejected.
    await expect(
      confirmManualFulfillment(db.pool, admin(), grantJobIds[0]!),
    ).rejects.toThrowError(/not awaiting manual fulfillment/);
  });
});

describe('deprovisioning', () => {
  it('completes revocations via REVOKE jobs, preserving the reason, and settles the role', async () => {
    fake.handler = () => ({ok: true});
    const userId = await newActiveUser('Lars Leaver');
    const assigned = await assignRoleToIdentity(db.pool, admin(), {
      identityId: userId,
      roleId,
      assignmentType: 'BIRTHRIGHT',
    });
    await enqueueProvisioningJobs(db.pool, systemContext());
    await runProvisioningWorker(db.pool, systemContext(), registry);

    await requestRoleRevocation(db.pool, admin(), assigned.roleAssignment.id, 'LEAVER');
    const {revokeJobIds} = await enqueueProvisioningJobs(db.pool, systemContext());
    expect(revokeJobIds).toHaveLength(2);

    const run = await runProvisioningWorker(db.pool, systemContext(), registry);
    expect(run.completed).toEqual(expect.arrayContaining(revokeJobIds));

    for (const g of assigned.entitlementAssignments) {
      const {rows} = await db.pool.query(
        'SELECT status, revoked_reason, revoked_at FROM entitlement_assignments WHERE id = $1',
        [g.id],
      );
      expect(rows[0]).toMatchObject({status: 'REVOKED', revoked_reason: 'LEAVER'});
      expect(rows[0].revoked_at).not.toBeNull();
    }
    expect(await roleAssignmentStatus(assigned.roleAssignment.id)).toBe('REVOKED');

    // Deprovisioning evidence: completed jobs with timestamps.
    const {rows: jobs} = await db.pool.query(
      `SELECT status, completed_at FROM provisioning_jobs WHERE id = ANY($1)`,
      [revokeJobIds],
    );
    for (const job of jobs) {
      expect(job.status).toBe('COMPLETED');
      expect(job.completed_at).not.toBeNull();
    }
  });

  it('cancels still-queued jobs with an audited reason', async () => {
    const userId = await newActiveUser('Cindy Cancelled');
    await grantTemporaryAccess(db.pool, admin(), {
      identityId: userId,
      entitlementId: entAId,
      expiresAt: FUTURE,
    });
    const {grantJobIds} = await enqueueProvisioningJobs(db.pool, systemContext());
    await cancelProvisioningJob(db.pool, admin(), grantJobIds[0]!, 'grant withdrawn');
    const {rows} = await db.pool.query('SELECT status FROM provisioning_jobs WHERE id = $1', [grantJobIds[0]]);
    expect(rows[0].status).toBe('CANCELLED');
    const audit = await fetchAuditEvents(db.pool, grantJobIds[0]!);
    expect(audit.at(-1)).toMatchObject({action: 'provisioning_job.cancelled'});
  });

  it('treats thrown connector errors as retryable failures', async () => {
    fake.handler = () => {
      throw new Error('socket hang up');
    };
    const userId = await newActiveUser('Tara Thrown');
    await grantTemporaryAccess(db.pool, admin(), {
      identityId: userId,
      entitlementId: entBId,
      expiresAt: FUTURE,
    });
    const {grantJobIds} = await enqueueProvisioningJobs(db.pool, systemContext());
    const run = await runProvisioningWorker(db.pool, systemContext(), registry);
    expect(run.failed).toEqual(grantJobIds);
    const {rows} = await db.pool.query(
      'SELECT last_error, attempt_count FROM provisioning_jobs WHERE id = $1',
      [grantJobIds[0]],
    );
    expect(rows[0]).toMatchObject({last_error: 'socket hang up', attempt_count: 1});
    fake.handler = () => ({ok: true});
  });
});
