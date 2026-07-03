/**
 * CLI entry point: `npm run migrate --workspace @iam/db`
 * Connects using DATABASE_URL and applies pending migrations.
 */

import pg from 'pg';
import {runMigrations} from './migrate.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({connectionString: databaseUrl});

try {
  await client.connect();
  const result = await runMigrations(client);
  for (const file of result.applied) {
    console.log(`applied  ${file}`);
  }
  console.log(`${result.applied.length} applied, ${result.skipped.length} already up to date`);
} finally {
  await client.end();
}
