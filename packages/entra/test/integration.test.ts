/**
 * End to end: grant in the ledger -> enqueue -> provisioning worker ->
 * EntraGraphConnector -> fake Microsoft Graph. Verifies the payload contract
 * between the orchestrator and the connector, and that a missing linked
 * account routes to the manual queue instead of failing silently.
 */

import {runMigrations} from '@iam/db';
import {
  changeIdentityStatus,
  ConnectorRegistry,
  createEntitlement,
  createIdentity,
  enqueueProvisioningJobs,
  grantTemporaryAccess,
  linkIdentityAccount,
  registerApplication,
  requestEntitlementRevocation,
  runProvisioningWorker,
  systemContext,
} from '@iam/services';
import pg from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EntraGraphConnector} from '../src/connector.js';
import {GraphClient} from '../src/graphClient.js';

const ADMIN_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const TEST_DB = `iam_entra_e2e_${Date.now()}`;
const FUTURE = new Date('2030-01-01T00:00:00Z');

let admin: pg.Client;
let pool: pg.Pool;

// Fake Entra directory: group id -> member object ids.
const directory = new Map<string, Set<string>>([['grp-finance', new Set()]]);
const graphCalls: string[] = [];

const graph = new GraphClient({
  tokenProvider: {getToken: async () => 'fake-token'},
  baseUrl: 'https://graph.test/v1.0',
  fetchImpl: async (url, init) => {
    const path = String(url).replace('https://graph.test/v1.0', '');
    const method = init?.method ?? 'GET';
    graphCalls.push(`${method} ${path}`);
    const memberCheck = path.match(/^\/groups\/([^/]+)\/members\/([^/$]+)$/);
    if (method === 'GET' && memberCheck) {
      const [, group, user] = memberCheck;
      return new Response(directory.get(group!)?.has(user!) ? '{"id":"x"}' : null, {
        status: directory.get(group!)?.has(user!) ? 200 : 404,
      });
    }
    const addRef = path.match(/^\/groups\/([^/]+)\/members\/\$ref$/);
    if (method === 'POST' && addRef) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      const user = body['@odata.id']!.split('/').at(-1)!;
      directory.get(addRef[1]!)?.add(user);
      return new Response(null, {status: 204});
    }
    const removeRef = path.match(/^\/groups\/([^/]+)\/members\/([^/]+)\/\$ref$/);
    if (method === 'DELETE' && removeRef) {
      const had = directory.get(removeRef[1]!)?.delete(removeRef[2]!);
      return new Response(null, {status: had ? 204 : 404});
    }
    return new Response(null, {status: 500});
  },
});

const registry = new ConnectorRegistry().register(new EntraGraphConnector(graph));

beforeAll(async () => {
  admin = new pg.Client({connectionString: ADMIN_URL});
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  const migrator = new pg.Client({connectionString: url.toString()});
  await migrator.connect();
  await runMigrations(migrator);
  await migrator.end();
  pool = new pg.Pool({connectionString: url.toString(), max: 5});
  pool.on('error', () => {});
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} (FORCE)`);
  await admin.end();
});

describe('Entra provisioning end to end', () => {
  it('grants and revokes group membership through the worker', async () => {
    const sys = systemContext();
    const owner = await createIdentity(pool, sys, {
      identityType: 'EMPLOYEE',
      displayName: 'Owner',
      primaryEmail: 'owner@corp.example.com',
    });
    const app = await registerApplication(pool, sys, {
      name: 'Entra ID',
      ownerIdentityId: owner.id,
      connectorType: 'ENTRA_GRAPH',
      fulfillmentMode: 'AUTOMATED',
    });
    const entitlement = await createEntitlement(pool, sys, {
      applicationId: app.id,
      code: 'FINANCE_GROUP',
      name: 'Finance group membership',
      externalRef: {entraGroupObjectId: 'grp-finance'},
    });

    const alice = await createIdentity(pool, sys, {
      identityType: 'EMPLOYEE',
      displayName: 'Alice',
      primaryEmail: 'alice@corp.example.com',
    });
    await changeIdentityStatus(pool, sys, alice.id, 'ACTIVE');
    await linkIdentityAccount(pool, sys, {
      identityId: alice.id,
      applicationId: app.id,
      accountIdentifier: 'alice@corp.example.com',
      externalRef: {objectId: 'oid-alice'},
    });

    const grant = await grantTemporaryAccess(pool, sys, {
      identityId: alice.id,
      entitlementId: entitlement.id,
      expiresAt: FUTURE,
    });
    await enqueueProvisioningJobs(pool, sys);
    const run = await runProvisioningWorker(pool, sys, registry);
    expect(run.completed).toHaveLength(1);
    expect(directory.get('grp-finance')!.has('oid-alice')).toBe(true);

    const status = await pool.query('SELECT status FROM entitlement_assignments WHERE id = $1', [grant.id]);
    expect(status.rows[0].status).toBe('ACTIVE');

    // Revoke: worker removes the membership and completes the revocation.
    await requestEntitlementRevocation(pool, sys, grant.id, 'MANUAL');
    await enqueueProvisioningJobs(pool, sys);
    const revokeRun = await runProvisioningWorker(pool, sys, registry);
    expect(revokeRun.completed).toHaveLength(1);
    expect(directory.get('grp-finance')!.has('oid-alice')).toBe(false);
    const revoked = await pool.query('SELECT status FROM entitlement_assignments WHERE id = $1', [grant.id]);
    expect(revoked.rows[0].status).toBe('REVOKED');
  });

  it('routes identities without a linked account to the manual queue', async () => {
    const sys = systemContext();
    const bob = await createIdentity(pool, sys, {
      identityType: 'EMPLOYEE',
      displayName: 'Bob Unlinked',
      primaryEmail: 'bob@corp.example.com',
    });
    await changeIdentityStatus(pool, sys, bob.id, 'ACTIVE');
    const ent = await pool.query(`SELECT id FROM entitlements LIMIT 1`);
    await grantTemporaryAccess(pool, sys, {
      identityId: bob.id,
      entitlementId: ent.rows[0].id,
      expiresAt: FUTURE,
    });
    await enqueueProvisioningJobs(pool, sys);
    const run = await runProvisioningWorker(pool, sys, registry);
    expect(run.manualRouted).toHaveLength(1);
    const job = await pool.query(
      `SELECT last_error FROM provisioning_jobs WHERE status = 'MANUAL_PENDING'`,
    );
    expect(job.rows[0].last_error).toMatch(/linked Entra account/);
  });
});
