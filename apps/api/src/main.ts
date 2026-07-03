import {EntraTokenVerifier} from '@iam/entra';
import {ConnectorRegistry, type Connector} from '@iam/services';
import pg from 'pg';
import {buildServer} from './server.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new pg.Pool({connectionString: databaseUrl, max: 10});

const tenantId = process.env['ENTRA_TENANT_ID'];
const audience = process.env['ENTRA_AUDIENCE'];
const verifier =
  tenantId && audience ? new EntraTokenVerifier({tenantId, audience}) : null;

// Dev connector: succeeds immediately so the demo environment can fulfill
// ENTRA_GRAPH jobs without a tenant. Replaced by EntraGraphConnector when
// Graph credentials are configured (see @iam/entra).
const devConnector: Connector = {
  type: 'ENTRA_GRAPH',
  execute: async () => ({ok: true}),
};
const registry = new ConnectorRegistry().register(devConnector);

const app = buildServer({pool, verifier, registry});
const port = Number(process.env['PORT'] ?? 4000);
await app.listen({port, host: '0.0.0.0'});
console.log(
  `IAM API on :${port} — ${verifier ? 'Entra bearer auth' : 'DEV mode (x-dev-actor header auth)'}`,
);
