/**
 * Minimal, transactional SQL migration runner.
 *
 * - Migrations are plain .sql files in ./migrations, applied in filename order.
 * - Each migration runs inside its own transaction.
 * - Applied migrations are recorded in schema_migrations with a SHA-256
 *   checksum; editing an already-applied file is detected and rejected.
 * - A Postgres advisory lock prevents two runners from racing.
 */

import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type pg from 'pg';

const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Arbitrary but stable app-wide lock key for "IAM schema migration in progress".
const MIGRATION_LOCK_KEY = 7_206_1991;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export class MigrationError extends Error {
  constructor(
    public readonly file: string,
    message: string,
    options?: {cause?: unknown},
  ) {
    super(`migration ${file}: ${message}`, options);
    this.name = 'MigrationError';
  }
}

export async function runMigrations(
  client: pg.Client,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const {rows} = await client.query<{name: string; checksum: string}>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const alreadyApplied = new Map(rows.map((r) => [r.name, r.checksum]));

    const result: MigrationResult = {applied: [], skipped: []};

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      const existing = alreadyApplied.get(file);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new MigrationError(
            file,
            'file changed after being applied; write a new migration instead of editing an applied one',
          );
        }
        result.skipped.push(file);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new MigrationError(file, err instanceof Error ? err.message : String(err), {
          cause: err,
        });
      }
      result.applied.push(file);
    }

    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}
