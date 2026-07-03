import {IllegalTransitionError, InvariantViolation} from '@iam/domain';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  changeIdentityStatus,
  createIdentity,
  getIdentity,
  linkIdentityAccount,
  listIdentities,
  NotFoundError,
  PermissionDeniedError,
  registerApplication,
  systemContext,
  updateIdentity,
  userContext,
} from '../src/index.js';
import {createTestDb, fetchAuditEvents, type TestDb} from './setup.js';

let db: TestDb;
let adminId: string;

const FULL = ['identity:read', 'identity:write', 'identity:lifecycle'] as const;

function admin() {
  return userContext(adminId, FULL, {requestContext: {ip: '10.0.0.1', route: 'test'}});
}

beforeAll(async () => {
  db = await createTestDb('iam_svc_identities');
  // Bootstrap the admin actor as SYSTEM: USER audit events require an
  // existing actor identity, and none exists in a fresh database.
  const identity = await createIdentity(db.pool, systemContext(), {
    identityType: 'EMPLOYEE',
    displayName: 'IAM Admin',
    primaryEmail: 'iam-admin@corp.example.com',
  });
  adminId = identity.id;
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('createIdentity', () => {
  it('creates an identity and writes an audit event in the same transaction', async () => {
    const identity = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Alice Smith',
      primaryEmail: 'alice@corp.example.com',
      department: 'Finance',
    });
    expect(identity.status).toBe('PENDING');

    const events = await fetchAuditEvents(db.pool, identity.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'identity.created',
      actor_identity_id: adminId,
      actor_type: 'USER',
      entity_type: 'identity',
    });
    expect(events[0]!['correlation_id']).toBeTruthy();
  });

  it('rejects invalid identity shapes before touching the database', async () => {
    await expect(
      createIdentity(db.pool, admin(), {
        identityType: 'CONTRACTOR',
        displayName: 'No End Date',
        primaryEmail: 'contractor@example.com',
      }),
    ).rejects.toThrowError(InvariantViolation);
  });

  it('denies callers without identity:write and writes nothing', async () => {
    const readOnly = userContext(adminId, ['identity:read']);
    await expect(
      createIdentity(db.pool, readOnly, {
        identityType: 'EMPLOYEE',
        displayName: 'Denied',
        primaryEmail: 'denied@example.com',
      }),
    ).rejects.toThrowError(PermissionDeniedError);
    const {rows} = await db.pool.query(
      `SELECT count(*)::int AS n FROM identities WHERE primary_email = 'denied@example.com'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('updateIdentity', () => {
  it('detects mover-relevant changes and journals a MOVER lifecycle event', async () => {
    const identity = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Bob Mover',
      primaryEmail: 'bob@corp.example.com',
      department: 'Sales',
    });
    await updateIdentity(db.pool, admin(), identity.id, {department: 'Marketing'});

    const {rows: events} = await db.pool.query(
      'SELECT event_type, payload FROM lifecycle_events WHERE identity_id = $1',
      [identity.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('MOVER');
    expect(events[0].payload).toEqual({
      before: {department: 'Sales'},
      after: {department: 'Marketing'},
    });

    const audit = await fetchAuditEvents(db.pool, identity.id);
    const updateEvent = audit.find((e) => e['action'] === 'identity.updated');
    expect(updateEvent?.['before_state']).toEqual({department: 'Sales'});
  });

  it('journals non-org changes as ATTRIBUTE_CHANGE', async () => {
    const identity = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Carol Rename',
      primaryEmail: 'carol@corp.example.com',
    });
    await updateIdentity(db.pool, admin(), identity.id, {displayName: 'Carol Renamed'});
    const {rows} = await db.pool.query(
      'SELECT event_type FROM lifecycle_events WHERE identity_id = $1',
      [identity.id],
    );
    expect(rows.map((r) => r.event_type)).toEqual(['ATTRIBUTE_CHANGE']);
  });

  it('is a no-op (no audit, no journal) when nothing changes', async () => {
    const identity = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Dave Same',
      primaryEmail: 'dave@corp.example.com',
      department: 'IT',
    });
    await updateIdentity(db.pool, admin(), identity.id, {department: 'IT'});
    const audit = await fetchAuditEvents(db.pool, identity.id);
    expect(audit.map((e) => e['action'])).toEqual(['identity.created']);
  });

  it('re-validates identity shape on update', async () => {
    const contractor = await createIdentity(db.pool, admin(), {
      identityType: 'CONTRACTOR',
      displayName: 'Eve Contractor',
      primaryEmail: 'eve@example.com',
      terminationDate: new Date('2030-06-30'),
    });
    await expect(
      updateIdentity(db.pool, admin(), contractor.id, {terminationDate: null}),
    ).rejects.toThrowError(InvariantViolation);
  });
});

describe('changeIdentityStatus (JML)', () => {
  it('activates a joiner and journals a JOINER event', async () => {
    const identity = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Frank Joiner',
      primaryEmail: 'frank@corp.example.com',
    });
    const activated = await changeIdentityStatus(db.pool, admin(), identity.id, 'ACTIVE');
    expect(activated.status).toBe('ACTIVE');

    const {rows} = await db.pool.query(
      'SELECT event_type, payload FROM lifecycle_events WHERE identity_id = $1',
      [identity.id],
    );
    expect(rows[0].event_type).toBe('JOINER');

    const audit = await fetchAuditEvents(db.pool, identity.id);
    expect(audit.map((e) => e['action'])).toContain('identity.status_changed');
  });

  it('processes a leaver through LEAVING to TERMINATED', async () => {
    const identity = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Grace Leaver',
      primaryEmail: 'grace@corp.example.com',
    });
    await changeIdentityStatus(db.pool, admin(), identity.id, 'ACTIVE');
    await changeIdentityStatus(db.pool, admin(), identity.id, 'LEAVING', 'resignation');
    await changeIdentityStatus(db.pool, admin(), identity.id, 'TERMINATED');

    const {rows} = await db.pool.query(
      `SELECT event_type FROM lifecycle_events WHERE identity_id = $1 ORDER BY occurred_at`,
      [identity.id],
    );
    expect(rows.map((r) => r.event_type)).toEqual(['JOINER', 'LEAVER', 'LEAVER']);
  });

  it('rejects illegal transitions and leaves no trace', async () => {
    const identity = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Heidi Illegal',
      primaryEmail: 'heidi@corp.example.com',
    });
    await expect(
      changeIdentityStatus(db.pool, admin(), identity.id, 'SUSPENDED'),
    ).rejects.toThrowError(IllegalTransitionError);
    const fresh = await getIdentity(db.pool, admin(), identity.id);
    expect(fresh.status).toBe('PENDING');
    const audit = await fetchAuditEvents(db.pool, identity.id);
    expect(audit.map((e) => e['action'])).toEqual(['identity.created']);
  });

  it('requires the identity:lifecycle permission', async () => {
    const noLifecycle = userContext(adminId, ['identity:read', 'identity:write']);
    await expect(
      changeIdentityStatus(db.pool, noLifecycle, adminId, 'ACTIVE'),
    ).rejects.toThrowError(PermissionDeniedError);
  });

  it('404s on unknown identities', async () => {
    await expect(
      changeIdentityStatus(db.pool, admin(), crypto.randomUUID(), 'ACTIVE'),
    ).rejects.toThrowError(NotFoundError);
  });
});

describe('linkIdentityAccount', () => {
  it('links a target-system account and audits it', async () => {
    const identity = await createIdentity(db.pool, admin(), {
      identityType: 'EMPLOYEE',
      displayName: 'Ivan Linked',
      primaryEmail: 'ivan@corp.example.com',
    });
    const app = await registerApplication(
      db.pool,
      userContext(adminId, ['application:write']),
      {name: 'Entra ID', ownerIdentityId: adminId, connectorType: 'ENTRA_GRAPH'},
    );
    const account = await linkIdentityAccount(db.pool, admin(), {
      identityId: identity.id,
      applicationId: app.id,
      accountIdentifier: 'ivan@corp.example.com',
      externalRef: {objectId: '00000000-1111-2222-3333-444444444444'},
    });
    const audit = await fetchAuditEvents(db.pool, account.id);
    expect(audit.map((e) => e['action'])).toEqual(['identity_account.linked']);
  });
});

describe('reads', () => {
  it('filters identity lists', async () => {
    const hits = await listIdentities(db.pool, admin(), {department: 'Marketing'});
    expect(hits.map((i) => i.displayName)).toEqual(['Bob Mover']);
  });
});
