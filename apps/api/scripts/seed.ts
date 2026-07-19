/**
 * One-shot demo seed (destructive: drops and recreates APP_DB).
 *   DATABASE_URL=postgres://... [APP_DB=iam_app] npx tsx scripts/seed.ts
 */
import {seedDemo} from './seedDemo.js';

const adminUrl =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const appDb = process.env['APP_DB'] ?? 'iam_app';

const counts = await seedDemo(adminUrl, appDb);
console.log(`seeded ${appDb}:`, counts);
