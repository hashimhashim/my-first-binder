/**
 * Container entrypoint (Node, not shell — immune to CRLF line-ending issues
 * on Windows checkouts). First boot: create + migrate + seed. Later boots:
 * migrate only, keeping data. Then start the API + UI.
 *
 * DB_HOSTPORT lets tests point at a local Postgres; in the compose stack it
 * defaults to the `db` service.
 */

const hostPort = process.env['DB_HOSTPORT'] ?? 'db:5432';
const appDb = process.env['APP_DB'] ?? 'iam_app';

// init.ts reads DATABASE_URL as the admin connection and APP_DB as the target.
process.env['DATABASE_URL'] = `postgres://postgres:postgres@${hostPort}/postgres`;
process.env['APP_DB'] = appDb;
await import('./init.js');

// main.ts reads DATABASE_URL as its live connection and PORT to listen on.
process.env['DATABASE_URL'] = `postgres://postgres:postgres@${hostPort}/${appDb}`;
process.env['PORT'] = process.env['PORT'] ?? '8090';
await import('../src/main.js');
