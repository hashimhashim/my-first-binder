/**
 * Container/production init — idempotent, data-preserving.
 *
 *   - Database missing            -> create it, migrate, seed the demo world
 *   - Database exists             -> apply any new migrations, KEEP all data
 *   - RESET_DEMO=true             -> drop and reseed (explicit opt-in only)
 *
 *   DATABASE_URL points at the postgres admin DB; APP_DB names the app
 *   database (default iam_app).
 */

import {runMigrations} from '@iam/db';
import pg from 'pg';
import {seedDemo} from './seedDemo.js';

const adminUrl =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const appDb = process.env['APP_DB'] ?? 'iam_app';
const reset = process.env['RESET_DEMO'] === 'true';

const admin = new pg.Client({connectionString: adminUrl});
await admin.connect();
const exists =
  (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [appDb])).rows.length > 0;
await admin.end();

if (!exists || reset) {
  console.log(
    !exists
      ? `==> ${appDb} does not exist yet: creating, migrating, seeding demo data`
      : `==> RESET_DEMO=true: dropping and reseeding ${appDb}`,
  );
  const counts = await seedDemo(adminUrl, appDb);
  console.log(`==> seeded ${appDb}:`, counts);
} else {
  console.log(`==> ${appDb} exists: applying pending migrations, keeping all data`);
  const url = new URL(adminUrl);
  url.pathname = `/${appDb}`;
  const client = new pg.Client({connectionString: url.toString()});
  await client.connect();
  const result = await runMigrations(client);
  await client.end();
  console.log(`==> migrations: ${result.applied.length} applied, ${result.skipped.length} current`);
}
