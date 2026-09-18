import {
  ClientCredentialsTokenProvider,
  EntraGraphConnector,
  EntraTokenVerifier,
  EnvSecretProvider,
  GraphClient,
} from '@iam/entra';
import {
  ConnectorRegistry,
  enqueueProvisioningJobs,
  processLifecycleEvents,
  runProvisioningWorker,
  sweepExpiredGrants,
  systemContext,
  type Connector,
} from '@iam/services';
import pg from 'pg';
import {buildServer} from './server.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new pg.Pool({connectionString: databaseUrl, max: 10});
const env = (name: string): string | null => {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : null;
};

// --- API sign-in: Entra bearer tokens when configured, dev personas otherwise
const tenantId = env('ENTRA_TENANT_ID');
const audience = env('ENTRA_AUDIENCE');
const verifier = tenantId && audience ? new EntraTokenVerifier({tenantId, audience}) : null;

// --- Provisioning connector: real Microsoft Graph when credentials are
// configured (secret read from the environment at use time, never stored),
// otherwise a dev connector that fulfills instantly.
const graphTenant = env('GRAPH_TENANT_ID') ?? tenantId;
const graphClientId = env('GRAPH_CLIENT_ID');
let connector: Connector;
if (graphTenant && graphClientId && env('GRAPH_CLIENT_SECRET')) {
  const graph = new GraphClient({
    tokenProvider: new ClientCredentialsTokenProvider({
      tenantId: graphTenant,
      clientId: graphClientId,
      clientSecretRef: 'GRAPH_CLIENT_SECRET',
      secrets: new EnvSecretProvider(),
    }),
  });
  connector = new EntraGraphConnector(graph);
  console.log('Provisioning: Microsoft Graph connector (live tenant)');
} else {
  connector = {type: 'ENTRA_GRAPH', execute: async () => ({ok: true})};
  console.log('Provisioning: dev connector (simulated fulfillment)');
}
const registry = new ConnectorRegistry().register(connector);

const app = buildServer({
  pool,
  verifier,
  registry,
  spa:
    verifier && env('ENTRA_SPA_CLIENT_ID') && env('ENTRA_API_SCOPE')
      ? {
          tenantId: tenantId!,
          clientId: env('ENTRA_SPA_CLIENT_ID')!,
          apiScope: env('ENTRA_API_SCOPE')!,
        }
      : null,
});

// --- Background worker: JML automation, job fan-out, connector execution,
// and the expiry sweep. Interval in ms; 0 disables (run externally instead).
const intervalMs = Number(process.env['WORKER_INTERVAL_MS'] ?? 60_000);
if (intervalMs > 0) {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      const sys = systemContext();
      await processLifecycleEvents(pool, sys);
      await sweepExpiredGrants(pool, sys);
      await enqueueProvisioningJobs(pool, sys);
      await runProvisioningWorker(pool, sys, registry);
    } catch (err) {
      console.error('worker tick failed:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  setInterval(tick, intervalMs).unref();
  void tick(); // run once at startup
  console.log(`Worker: running every ${Math.round(intervalMs / 1000)}s`);
} else {
  console.log('Worker: disabled (WORKER_INTERVAL_MS=0)');
}

const port = Number(process.env['PORT'] ?? 4000);
await app.listen({port, host: '0.0.0.0'});
console.log(
  `IAM API on :${port} — ${verifier ? 'Entra bearer auth' : 'DEV mode (x-dev-actor header auth)'}`,
);
