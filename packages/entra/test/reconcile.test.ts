/**
 * Reconciliation: seeds a ledger and a fake Entra tenant that deliberately
 * disagree, and verifies each drift class is found and audited.
 */

import {runMigrations} from '@iam/db';
import {
  activateGrant,
  changeIdentityStatus,
  createEntitlement,
  createIdentity,
  grantTemporaryAccess,
  linkIdentityAccount,
  registerApplication,
  systemContext,
} from '@iam/services';
import pg from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {GraphClient} from '../src/graphClient.js';
import {listGroupMemberIds, reconcileEntraGroups} from '../src/reconcile.js';

const ADMIN_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const TEST_DB = `iam_reconcile_${Date.now()}`;
const FUTURE = new Date('2030-01-01T00:00:00Z');

let admin: pg.Client;
let pool: pg.Pool;

// Fake tenant: grp-a has alice (expected) and a rogue member; bob is
// missing from it despite an ACTIVE grant. Members are paged 1-per-page to
// exercise @odata.nextLink handling.
const GROUP_MEMBERS: Record<string, string[]> = {
  'grp-a': ['oid-alice', 'oid-rogue'],
};

const graph = new GraphClient({
  tokenProvider: {getToken: async () => 't'},
  baseUrl: 'https://graph.test/v1.0',
  fetchImpl: async (url) => {
    const u = new URL(String(url));
    const match = u.pathname.match(/\/groups\/([^/]+)\/members$/);
    if (!match) return new Response(null, {status: 500});
    const members = GROUP_MEMBERS[match[1]!] ?? [];
    const skip = Number(u.searchParams.get('$skip') ?? 0);
    const page = members.slice(skip, skip + 1).map((id) => ({id}));
    const body: Record<string, unknown> = {value: page};
    if (skip + 1 < members.length) {
      body['@odata.nextLink'] =
        `https://graph.test/v1.0/groups/${match[1]}/members?$select=id&$top=100&$skip=${skip + 1}`;
    }
    return new Response(JSON.stringify(body), {status: 200});
  },
});

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

  const sys = systemContext();
  const owner = await createIdentity(pool, sys, {
    identityType: 'EMPLOYEE', displayName: 'Owner', primaryEmail: 'owner@corp.example.com',
  });
  const app = await registerApplication(pool, sys, {
    name: 'Entra ID', ownerIdentityId: owner.id, connectorType: 'ENTRA_GRAPH',
  });
  const ent = await createEntitlement(pool, sys, {
    applicationId: app.id, code: 'GRP_A', name: 'Group A',
    externalRef: {entraGroupObjectId: 'grp-a'},
  });

  const mkHolder = async (name: string, objectId: string | null) => {
    const identity = await createIdentity(pool, sys, {
      identityType: 'EMPLOYEE', displayName: name,
      primaryEmail: `${name.toLowerCase()}@corp.example.com`,
    });
    await changeIdentityStatus(pool, sys, identity.id, 'ACTIVE');
    if (objectId !== null) {
      await linkIdentityAccount(pool, sys, {
        identityId: identity.id, applicationId: app.id,
        accountIdentifier: `${name.toLowerCase()}@corp.example.com`,
        externalRef: {objectId},
      });
    }
    const grant = await grantTemporaryAccess(pool, sys, {
      identityId: identity.id, entitlementId: ent.id, expiresAt: FUTURE,
    });
    await activateGrant(pool, sys, 'entitlement_assignments', grant.id);
    return identity;
  };

  await mkHolder('Alice', 'oid-alice'); // in sync
  await mkHolder('Bob', 'oid-bob');     // ACTIVE grant, absent from tenant -> MISSING_ACCESS
  await mkHolder('Cara', null);          // ACTIVE grant, no linked account -> UNLINKED_ACCOUNT

  // The rogue member maps to a known identity with no grant.
  const rogue = await createIdentity(pool, sys, {
    identityType: 'EMPLOYEE', displayName: 'Rex Rogue', primaryEmail: 'rex@corp.example.com',
  });
  await changeIdentityStatus(pool, sys, rogue.id, 'ACTIVE');
  await linkIdentityAccount(pool, sys, {
    identityId: rogue.id, applicationId: app.id,
    accountIdentifier: 'rex@corp.example.com', externalRef: {objectId: 'oid-rogue'},
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} (FORCE)`);
  await admin.end();
});

describe('group member listing', () => {
  it('follows @odata.nextLink paging', async () => {
    const members = await listGroupMemberIds(graph, 'grp-a');
    expect(members).toEqual(new Set(['oid-alice', 'oid-rogue']));
  });
});

describe('reconciliation', () => {
  it('finds rogue, missing, and unverifiable access — and audits everything', async () => {
    const report = await reconcileEntraGroups(pool, systemContext(), graph);
    expect(report.groupsChecked).toBe(1);
    expect(report.grantsChecked).toBe(3);
    expect(report.findings).toHaveLength(3);

    const byKind = Object.fromEntries(report.findings.map((f) => [f.kind, f]));
    expect(byKind['MISSING_ACCESS']).toMatchObject({identityName: 'Bob', memberObjectId: 'oid-bob'});
    expect(byKind['UNLINKED_ACCOUNT']).toMatchObject({identityName: 'Cara', memberObjectId: null});
    expect(byKind['ROGUE_ACCESS']).toMatchObject({identityName: 'Rex Rogue', memberObjectId: 'oid-rogue'});

    const audit = await pool.query(
      `SELECT action, count(*)::int AS n FROM audit_events
       WHERE action LIKE 'reconciliation.%' GROUP BY action ORDER BY action`,
    );
    expect(audit.rows).toEqual([
      {action: 'reconciliation.completed', n: 1},
      {action: 'reconciliation.drift_detected', n: 3},
    ]);
  });

  it('reports clean when ledger and tenant agree', async () => {
    // Align the tenant: add bob, drop the rogue; Cara's grant still can't be
    // verified so she remains the only finding.
    GROUP_MEMBERS['grp-a'] = ['oid-alice', 'oid-bob'];
    const report = await reconcileEntraGroups(pool, systemContext(), graph);
    expect(report.findings.map((f) => f.kind)).toEqual(['UNLINKED_ACCOUNT']);
  });
});
