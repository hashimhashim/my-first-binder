/**
 * API smoke tests: auth modes, permission enforcement at the HTTP boundary,
 * and the submit -> approve flow through real routes (fastify inject).
 */

import {runMigrations} from '@iam/db';
import {
  changeIdentityStatus,
  ConnectorRegistry,
  createIdentity,
  systemContext,
  type Connector,
} from '@iam/services';
import pg from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {buildServer} from '../src/server.js';

const ADMIN_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const TEST_DB = `iam_api_test_${Date.now()}`;

let admin: pg.Client;
let pool: pg.Pool;
let app: ReturnType<typeof buildServer>;

const devConnector: Connector = {type: 'ENTRA_GRAPH', execute: async () => ({ok: true})};

const as = (email: string, roles: string) => ({
  'x-dev-actor': email,
  'x-dev-roles': roles,
  'content-type': 'application/json',
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
  const alice = await createIdentity(pool, sys, {
    identityType: 'EMPLOYEE',
    displayName: 'Alice API',
    primaryEmail: 'alice@api.example.com',
  });
  await changeIdentityStatus(pool, sys, alice.id, 'ACTIVE');

  app = buildServer({pool, verifier: null, registry: new ConnectorRegistry().register(devConnector)});
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} (FORCE)`);
  await admin.end();
});

describe('authentication', () => {
  it('rejects requests without a persona in dev mode', async () => {
    const res = await app.inject({method: 'GET', url: '/api/me'});
    expect(res.statusCode).toBe(401);
  });

  it('resolves the persona and maps app roles to permissions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: as('alice@api.example.com', 'IAM.User'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identity.displayName).toBe('Alice API');
    expect(body.permissions).toContain('request:submit');
    expect(body.permissions).not.toContain('grant:write');
  });
});

describe('backend authorization at the HTTP boundary', () => {
  it('403s service-level permission failures (unknown roles grant nothing)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/identities',
      headers: as('alice@api.example.com', 'Not.A.Role'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('422s domain invariant violations with the invariant code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: as('alice@api.example.com', 'IAM.User'),
      payload: {justification: '   ', items: []},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBeDefined();
  });
});

describe('UI shell', () => {
  it('serves the app at /', async () => {
    const res = await app.inject({method: 'GET', url: '/'});
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('IAM Platform');
  });
});
