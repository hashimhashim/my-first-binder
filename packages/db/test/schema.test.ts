/**
 * Schema integration tests: apply all migrations to a throwaway Postgres
 * database and verify the IAM invariants the schema must enforce on its own,
 * regardless of application code.
 *
 * Requires a reachable Postgres superuser/admin connection via
 * DATABASE_URL (default: postgres://postgres:postgres@127.0.0.1:5432/postgres).
 */

import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {MigrationError, runMigrations} from '../src/migrate.js';

const ADMIN_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const TEST_DB = `iam_schema_test_${Date.now()}`;

let admin: pg.Client;
let db: pg.Client;

// Seeded fixture ids
let ownerId: string;
let userId: string;
let appId: string;
let entitlementId: string;
let roleId: string;

const FUTURE = '2030-01-01T00:00:00Z';

async function insertIdentity(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const row: Record<string, unknown> = {
    identity_type: 'EMPLOYEE',
    display_name: 'Test User',
    primary_email: `user-${crypto.randomUUID()}@example.com`,
    status: 'ACTIVE',
    ...overrides,
  };
  const cols = Object.keys(row);
  const params = cols.map((_, i) => `$${i + 1}`);
  const res = await db.query<{id: string}>(
    `INSERT INTO identities (${cols.join(', ')}) VALUES (${params.join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  admin = new pg.Client({connectionString: ADMIN_URL});
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEST_DB}`);

  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${TEST_DB}`;
  db = new pg.Client({connectionString: dbUrl.toString()});
  await db.connect();

  const result = await runMigrations(db);
  expect(result.applied.length).toBeGreaterThanOrEqual(9);

  // Shared fixtures
  ownerId = await insertIdentity({display_name: 'App Owner'});
  userId = await insertIdentity({display_name: 'Bene Ficiary'});
  const app = await db.query<{id: string}>(
    `INSERT INTO applications (name, owner_identity_id) VALUES ('Test App', $1) RETURNING id`,
    [ownerId],
  );
  appId = app.rows[0]!.id;
  const ent = await db.query<{id: string}>(
    `INSERT INTO entitlements (application_id, code, name) VALUES ($1, 'READER', 'Reader') RETURNING id`,
    [appId],
  );
  entitlementId = ent.rows[0]!.id;
  const role = await db.query<{id: string}>(
    `INSERT INTO business_roles (code, name, owner_identity_id) VALUES ('FIN_BASE', 'Finance Base', $1) RETURNING id`,
    [ownerId],
  );
  roleId = role.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  await db?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} (FORCE)`);
    await admin.end();
  }
});

describe('migration runner', () => {
  it('is a no-op when re-run', async () => {
    const rerun = await runMigrations(db);
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped.length).toBeGreaterThanOrEqual(9);
  });

  it('rejects editing an already-applied migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iam-mig-'));
    const file = join(dir, '9999_tamper_check.sql');
    await writeFile(file, 'CREATE TABLE tamper_check_probe (id INT);');
    await runMigrations(db, dir);
    await writeFile(file, 'CREATE TABLE tamper_check_probe (id BIGINT);');
    await expect(runMigrations(db, dir)).rejects.toThrowError(MigrationError);
  });
});

describe('identity repository constraints', () => {
  it('requires a sponsor for SERVICE identities', async () => {
    await expect(
      insertIdentity({identity_type: 'SERVICE', primary_email: null}),
    ).rejects.toThrowError(/identities_service_requires_sponsor/);
    await expect(
      insertIdentity({identity_type: 'SERVICE', primary_email: null, sponsor_identity_id: ownerId}),
    ).resolves.toBeTruthy();
  });

  it('requires a contract end date for CONTRACTOR identities', async () => {
    await expect(insertIdentity({identity_type: 'CONTRACTOR'})).rejects.toThrowError(
      /identities_contractor_requires_end/,
    );
    await expect(
      insertIdentity({identity_type: 'CONTRACTOR', termination_date: '2030-06-30'}),
    ).resolves.toBeTruthy();
  });

  it('requires email for employees and a linked identity for privileged accounts', async () => {
    await expect(insertIdentity({primary_email: null})).rejects.toThrowError(
      /identities_human_requires_email/,
    );
    await expect(
      insertIdentity({identity_type: 'PRIVILEGED', primary_email: null}),
    ).rejects.toThrowError(/identities_privileged_requires_link/);
    await expect(
      insertIdentity({identity_type: 'PRIVILEGED', primary_email: null, linked_identity_id: userId}),
    ).resolves.toBeTruthy();
  });

  it('touches updated_at on update', async () => {
    const before = await db.query('SELECT updated_at FROM identities WHERE id = $1', [userId]);
    await db.query(`UPDATE identities SET department = 'Finance' WHERE id = $1`, [userId]);
    const after = await db.query('SELECT updated_at FROM identities WHERE id = $1', [userId]);
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]!.updated_at.getTime(),
    );
  });
});

describe('grant ledger constraints', () => {
  it('rejects a TEMPORARY role assignment without expiry', async () => {
    await expect(
      db.query(
        `INSERT INTO role_assignments (identity_id, role_id, assignment_type) VALUES ($1, $2, 'TEMPORARY')`,
        [userId, roleId],
      ),
    ).rejects.toThrowError(/role_assignments_temporary_requires_expiry/);
  });

  it('rejects EXCEPTION and TEMPORARY entitlement grants without expiry', async () => {
    for (const type of ['EXCEPTION', 'TEMPORARY']) {
      await expect(
        db.query(
          `INSERT INTO entitlement_assignments (identity_id, entitlement_id, assignment_type) VALUES ($1, $2, $3)`,
          [userId, entitlementId, type],
        ),
      ).rejects.toThrowError(/entitlement_assignments_expiry_required/);
    }
  });

  it('requires ROLE_DERIVED grants to reference a role assignment, and forbids it otherwise', async () => {
    await expect(
      db.query(
        `INSERT INTO entitlement_assignments (identity_id, entitlement_id, assignment_type) VALUES ($1, $2, 'ROLE_DERIVED')`,
        [userId, entitlementId],
      ),
    ).rejects.toThrowError(/entitlement_assignments_source_matches_type/);

    const ra = await db.query<{id: string}>(
      `INSERT INTO role_assignments (identity_id, role_id, assignment_type) VALUES ($1, $2, 'BIRTHRIGHT') RETURNING id`,
      [userId, roleId],
    );
    await expect(
      db.query(
        `INSERT INTO entitlement_assignments (identity_id, entitlement_id, assignment_type, source_role_assignment_id, expires_at)
         VALUES ($1, $2, 'TEMPORARY', $3, $4)`,
        [userId, entitlementId, ra.rows[0]!.id, FUTURE],
      ),
    ).rejects.toThrowError(/entitlement_assignments_source_matches_type/);
  });

  it('allows at most one live grant per identity+entitlement, and a new one after revocation', async () => {
    const insert = () =>
      db.query<{id: string}>(
        `INSERT INTO entitlement_assignments (identity_id, entitlement_id, assignment_type, expires_at)
         VALUES ($1, $2, 'TEMPORARY', $3) RETURNING id`,
        [userId, entitlementId, FUTURE],
      );
    const first = await insert();
    await expect(insert()).rejects.toThrowError(/entitlement_assignments_one_live/);

    // Revocation frees the slot — but only with reason + timestamp recorded.
    await expect(
      db.query(`UPDATE entitlement_assignments SET status = 'REVOKED' WHERE id = $1`, [
        first.rows[0]!.id,
      ]),
    ).rejects.toThrowError(/entitlement_assignments_revoked_fields/);
    await db.query(
      `UPDATE entitlement_assignments
       SET status = 'REVOKED', revoked_reason = 'EXPIRY', revoked_at = now() WHERE id = $1`,
      [first.rows[0]!.id],
    );
    await expect(insert()).resolves.toBeTruthy();
  });

  it('policy exceptions always carry an expiry and a justification', async () => {
    const grant = await db.query<{id: string}>(
      `INSERT INTO entitlement_assignments (identity_id, entitlement_id, assignment_type, expires_at)
       VALUES ($1, $2, 'EXCEPTION', $3) RETURNING id`,
      [ownerId, entitlementId, FUTURE],
    );
    await expect(
      db.query(
        `INSERT INTO policy_exceptions (entitlement_assignment_id, exception_type, justification, approved_by_identity_id, expires_at)
         VALUES ($1, 'DIRECT_ACCESS', '   ', $2, $3)`,
        [grant.rows[0]!.id, ownerId, FUTURE],
      ),
    ).rejects.toThrowError(/policy_exceptions_justification_nonempty/);
    await expect(
      db.query(
        `INSERT INTO policy_exceptions (entitlement_assignment_id, exception_type, justification, approved_by_identity_id, expires_at)
         VALUES ($1, 'DIRECT_ACCESS', 'break-glass for incident 42', $2, $3)`,
        [grant.rows[0]!.id, ownerId, FUTURE],
      ),
    ).resolves.toBeTruthy();
  });
});

describe('request and approval constraints', () => {
  async function createRequest(): Promise<string> {
    const res = await db.query<{id: string}>(
      `INSERT INTO access_requests (requester_identity_id, beneficiary_identity_id, justification)
       VALUES ($1, $1, 'need access for quarter close') RETURNING id`,
      [userId],
    );
    return res.rows[0]!.id;
  }

  it('request items reference exactly one target matching their type', async () => {
    const requestId = await createRequest();
    await expect(
      db.query(
        `INSERT INTO access_request_items (request_id, target_type, role_id, entitlement_id)
         VALUES ($1, 'ROLE', $2, $3)`,
        [requestId, roleId, entitlementId],
      ),
    ).rejects.toThrowError(/access_request_items_target_matches/);
    await expect(
      db.query(
        `INSERT INTO access_request_items (request_id, target_type, role_id) VALUES ($1, 'ROLE', $2)`,
        [requestId, roleId],
      ),
    ).resolves.toBeTruthy();
  });

  it('blocks self-approval at the database level', async () => {
    const requestId = await createRequest();
    await expect(
      db.query(
        `INSERT INTO approvals (request_id, stage_order, stage_type, approver_identity_id)
         VALUES ($1, 1, 'MANAGER', $2)`,
        [requestId, userId],
      ),
    ).rejects.toThrowError(/self-approval forbidden/);
    // Delegating to the beneficiary is equally forbidden.
    await expect(
      db.query(
        `INSERT INTO approvals (request_id, stage_order, stage_type, approver_identity_id, delegated_to_identity_id)
         VALUES ($1, 1, 'MANAGER', $2, $3)`,
        [requestId, ownerId, userId],
      ),
    ).rejects.toThrowError(/self-approval forbidden/);
    await expect(
      db.query(
        `INSERT INTO approvals (request_id, stage_order, stage_type, approver_identity_id)
         VALUES ($1, 1, 'MANAGER', $2)`,
        [requestId, ownerId],
      ),
    ).resolves.toBeTruthy();
  });
});

describe('provisioning job constraints', () => {
  it('targets exactly one object and keeps idempotency keys unique', async () => {
    const granteeId = await insertIdentity({display_name: 'Provisioning Grantee'});
    const grant = await db.query<{id: string}>(
      `INSERT INTO entitlement_assignments (identity_id, entitlement_id, assignment_type, expires_at)
       VALUES ($1, $2, 'TEMPORARY', $3) RETURNING id`,
      [granteeId, entitlementId, FUTURE],
    );
    const grantId = grant.rows[0]!.id;

    await expect(
      db.query(
        `INSERT INTO provisioning_jobs (job_type, application_id, connector_type, idempotency_key)
         VALUES ('GRANT', $1, 'MANUAL', 'job-no-target')`,
        [appId],
      ),
    ).rejects.toThrowError(/provisioning_jobs_exactly_one_target/);

    const insertJob = (key: string) =>
      db.query(
        `INSERT INTO provisioning_jobs (job_type, application_id, connector_type, idempotency_key, entitlement_assignment_id)
         VALUES ('GRANT', $1, 'MANUAL', $2, $3)`,
        [appId, key, grantId],
      );
    await expect(insertJob('job-key-1')).resolves.toBeTruthy();
    await expect(insertJob('job-key-1')).rejects.toThrowError(/idempotency_key/);
  });

  it('manual confirmation must be attributed, timestamped, and in a confirmed status', async () => {
    const account = await db.query<{id: string}>(
      `INSERT INTO identity_accounts (identity_id, application_id, account_identifier)
       VALUES ($1, $2, 'user@corp.example.com') RETURNING id`,
      [userId, appId],
    );
    // Timestamp without attribution is rejected.
    await expect(
      db.query(
        `INSERT INTO provisioning_jobs
           (job_type, application_id, connector_type, idempotency_key, identity_account_id,
            manual_confirmed_at, status)
         VALUES ('GRANT', $1, 'MANUAL', 'job-key-manual-broken', $2, now(), 'MANUAL_CONFIRMED')`,
        [appId, account.rows[0]!.id],
      ),
    ).rejects.toThrowError(/provisioning_jobs_manual_confirmation_complete/);
    // Confirmation fields require a confirmed/cancelled status.
    await expect(
      db.query(
        `INSERT INTO provisioning_jobs
           (job_type, application_id, connector_type, idempotency_key, identity_account_id,
            manual_confirmed_at, manual_confirmed_by_identity_id, status)
         VALUES ('GRANT', $1, 'MANUAL', 'job-key-manual-wrong-status', $2, now(), $3, 'QUEUED')`,
        [appId, account.rows[0]!.id, ownerId],
      ),
    ).rejects.toThrowError(/provisioning_jobs_confirmed_status/);
    // Fully attributed confirmation in the right status is accepted.
    await expect(
      db.query(
        `INSERT INTO provisioning_jobs
           (job_type, application_id, connector_type, idempotency_key, identity_account_id,
            manual_confirmed_at, manual_confirmed_by_identity_id, status)
         VALUES ('GRANT', $1, 'MANUAL', 'job-key-manual-ok', $2, now(), $3, 'MANUAL_CONFIRMED')`,
        [appId, account.rows[0]!.id, ownerId],
      ),
    ).resolves.toBeTruthy();
  });
});

describe('audit log', () => {
  it('accepts catalog-shaped actions and rejects malformed ones', async () => {
    await expect(
      db.query(
        `INSERT INTO audit_events (actor_type, action, entity_type) VALUES ('SYSTEM', 'DROP TABLE', 'grant')`,
      ),
    ).rejects.toThrowError(/audit_events_action_format/);
    await expect(
      db.query(
        `INSERT INTO audit_events (actor_type, action, entity_type) VALUES ('SYSTEM', 'grant.revoked', 'entitlement_assignment')`,
      ),
    ).resolves.toBeTruthy();
  });

  it('requires an actor identity for USER events', async () => {
    await expect(
      db.query(
        `INSERT INTO audit_events (actor_type, action, entity_type) VALUES ('USER', 'grant.created', 'grant')`,
      ),
    ).rejects.toThrowError(/audit_events_user_has_actor/);
  });

  it('is append-only: UPDATE and DELETE are blocked', async () => {
    const res = await db.query<{id: string}>(
      `INSERT INTO audit_events (actor_type, action, entity_type)
       VALUES ('SYSTEM', 'grant.expired', 'entitlement_assignment') RETURNING id`,
    );
    const id = res.rows[0]!.id;
    await expect(
      db.query(`UPDATE audit_events SET action = 'grant.created' WHERE id = $1`, [id]),
    ).rejects.toThrowError(/append-only/);
    await expect(db.query(`DELETE FROM audit_events WHERE id = $1`, [id])).rejects.toThrowError(
      /append-only/,
    );
  });
});

describe('access review constraints', () => {
  it('review items reference exactly one grant and record who decided', async () => {
    const campaign = await db.query<{id: string}>(
      `INSERT INTO access_review_campaigns (name, reviewer_strategy, created_by_identity_id)
       VALUES ('Q3 finance review', 'MANAGER', $1) RETURNING id`,
      [ownerId],
    );
    const campaignId = campaign.rows[0]!.id;

    await expect(
      db.query(
        `INSERT INTO access_review_items (campaign_id, reviewer_identity_id, snapshot)
         VALUES ($1, $2, '{}')`,
        [campaignId, ownerId],
      ),
    ).rejects.toThrowError(/access_review_items_exactly_one_grant/);

    const grant = await db.query<{id: string}>(
      `SELECT id FROM entitlement_assignments LIMIT 1`,
    );
    const item = await db.query<{id: string}>(
      `INSERT INTO access_review_items (campaign_id, reviewer_identity_id, snapshot, entitlement_assignment_id)
       VALUES ($1, $2, '{"held": true}', $3) RETURNING id`,
      [campaignId, ownerId, grant.rows[0]!.id],
    );
    // Deciding without attribution is rejected.
    await expect(
      db.query(`UPDATE access_review_items SET decision = 'CERTIFIED' WHERE id = $1`, [
        item.rows[0]!.id,
      ]),
    ).rejects.toThrowError(/access_review_items_decided_fields/);
    await expect(
      db.query(
        `UPDATE access_review_items
         SET decision = 'CERTIFIED', decided_at = now(), decided_by_identity_id = $2 WHERE id = $1`,
        [item.rows[0]!.id, ownerId],
      ),
    ).resolves.toBeTruthy();
  });
});
