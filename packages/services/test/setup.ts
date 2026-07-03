/**
 * Test harness: creates a throwaway database, applies all @iam/db migrations,
 * and hands back a pool plus a teardown that drops the database.
 */

import {runMigrations} from '@iam/db';
import pg from 'pg';

const ADMIN_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export interface TestDb {
  pool: pg.Pool;
  teardown: () => Promise<void>;
}

export async function createTestDb(prefix: string): Promise<TestDb> {
  const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({connectionString: ADMIN_URL});
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);

  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${name}`;
  const migrator = new pg.Client({connectionString: dbUrl.toString()});
  await migrator.connect();
  await runMigrations(migrator);
  await migrator.end();

  const pool = new pg.Pool({connectionString: dbUrl.toString(), max: 5});
  return {
    pool,
    teardown: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} (FORCE)`);
      await admin.end();
    },
  };
}

export async function fetchAuditEvents(
  pool: pg.Pool,
  entityId: string,
): Promise<Array<Record<string, unknown>>> {
  const {rows} = await pool.query(
    'SELECT * FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at',
    [entityId],
  );
  return rows as Array<Record<string, unknown>>;
}
