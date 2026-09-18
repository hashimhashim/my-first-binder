/**
 * End-to-end demo: drives the whole IAM platform against a fresh database
 * with a simulated Entra tenant, then dumps the resulting state as JSON.
 *
 *   npx tsx scripts/demo.ts /path/to/output.json
 *
 * Storyline
 *   1. Joiner: Alice joins Finance; birthright role provisions her into the
 *      Finance-Reporting Entra group via the Graph connector.
 *   2. Self-service: Alice requests privileged ERP-Admins membership and a
 *      mainframe entitlement, both time-boxed. Chain: manager -> app owner
 *      -> security. Fulfillment creates EXCEPTION grants + policy records.
 *   3. Provisioning: the Entra job executes automatically; the mainframe
 *      job routes to the manual queue and the app owner confirms it.
 *   4. SoD: Bob holds GL-Postings and requests GL-Approvals — blocked.
 *   5. Expiry: Bob's temporary grant lapses; the sweep revokes it.
 *   6. Leaver: Bob is terminated; all remaining access is deprovisioned.
 */

import {runMigrations} from '@iam/db';
import {
  addRoleEntitlement,
  assignRoleToIdentity,
  changeIdentityStatus,
  ConnectorRegistry,
  confirmManualFulfillment,
  createBusinessRole,
  createEntitlement,
  createIdentity,
  decideApproval,
  enqueueProvisioningJobs,
  getRequestTrail,
  grantTemporaryAccess,
  linkIdentityAccount,
  listIdentityAccess,
  registerApplication,
  requestEntitlementRevocation,
  requestRoleRevocation,
  runProvisioningWorker,
  submitAccessRequest,
  sweepExpiredGrants,
  systemContext,
  userContext,
  type Permission,
} from '@iam/services';
import {writeFile} from 'node:fs/promises';
import pg from 'pg';
import {EntraGraphConnector} from '../src/connector.js';
import {GraphClient} from '../src/graphClient.js';

const ADMIN_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const OUT = process.argv[2] ?? 'demo-output.json';
const DB = `iam_demo_${Date.now()}`;

// --- simulated Entra tenant ---------------------------------------------
const directory = new Map<string, Set<string>>([
  ['grp-finance-reporting', new Set()],
  ['grp-erp-admins', new Set()],
]);
const graphLog: string[] = [];
const graph = new GraphClient({
  tokenProvider: {getToken: async () => 'demo-token'},
  baseUrl: 'https://graph.demo/v1.0',
  fetchImpl: async (url, init) => {
    const path = String(url).replace('https://graph.demo/v1.0', '');
    const method = init?.method ?? 'GET';
    graphLog.push(`${method} ${path}`);
    const check = path.match(/^\/groups\/([^/]+)\/members\/([^/$]+)$/);
    if (method === 'GET' && check) {
      const isMember = directory.get(check[1]!)?.has(check[2]!) ?? false;
      return new Response(isMember ? '{"id":"member"}' : null, {status: isMember ? 200 : 404});
    }
    const add = path.match(/^\/groups\/([^/]+)\/members\/\$ref$/);
    if (method === 'POST' && add) {
      const user = (JSON.parse(String(init?.body)) as Record<string, string>)['@odata.id']!
        .split('/')
        .at(-1)!;
      directory.get(add[1]!)?.add(user);
      return new Response(null, {status: 204});
    }
    const del = path.match(/^\/groups\/([^/]+)\/members\/([^/]+)\/\$ref$/);
    if (method === 'DELETE' && del) {
      const had = directory.get(del[1]!)?.delete(del[2]!) ?? false;
      return new Response(null, {status: had ? 204 : 404});
    }
    return new Response(null, {status: 500});
  },
});
const registry = new ConnectorRegistry().register(new EntraGraphConnector(graph));

// --------------------------------------------------------------------------

const ALL: Permission[] = [
  'identity:read', 'identity:write', 'identity:lifecycle',
  'application:read', 'application:write', 'catalog:read', 'entitlement:write', 'role:write',
  'grant:read', 'grant:write', 'request:read', 'request:submit', 'request:approve',
  'provisioning:read', 'provisioning:write', 'provisioning:confirm',
];
const asUser = (id: string) =>
  userContext(id, ['request:read', 'request:submit', 'request:approve', 'provisioning:read', 'provisioning:confirm']);

async function main(): Promise<void> {
  const admin = new pg.Client({connectionString: ADMIN_URL});
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB}`;
  const migrator = new pg.Client({connectionString: url.toString()});
  await migrator.connect();
  await runMigrations(migrator);
  await migrator.end();
  const pool = new pg.Pool({connectionString: url.toString(), max: 5});
  const sys = systemContext();
  const notes: Array<{step: string; detail: string}> = [];
  const note = (step: string, detail: string) => notes.push({step, detail});

  try {
    // --- org & catalog ----------------------------------------------------
    const iamAdmin = await createIdentity(pool, sys, {
      identityType: 'EMPLOYEE', displayName: 'IAM Platform Admin',
      primaryEmail: 'iam-admin@contoso.com', department: 'Security', jobTitle: 'IAM Engineer',
    });
    const adminCtx = userContext(iamAdmin.id, ALL);
    const mkPerson = async (name: string, email: string, dept: string, title: string, managerId?: string) => {
      const p = await createIdentity(pool, adminCtx, {
        identityType: 'EMPLOYEE', displayName: name, primaryEmail: email,
        department: dept, jobTitle: title, managerId: managerId ?? null,
      });
      await changeIdentityStatus(pool, adminCtx, p.id, 'ACTIVE');
      return p;
    };
    const mona = await mkPerson('Mona Manager', 'mona@contoso.com', 'Finance', 'Finance Director');
    const oscar = await mkPerson('Oscar Owner', 'oscar@contoso.com', 'IT', 'Application Owner', mona.id);
    const sam = await mkPerson('Sam Security', 'sam@contoso.com', 'Security', 'Security Officer', mona.id);

    const entraApp = await registerApplication(pool, adminCtx, {
      name: 'Microsoft Entra ID', ownerIdentityId: oscar.id, securityOfficerIdentityId: sam.id,
      connectorType: 'ENTRA_GRAPH', fulfillmentMode: 'AUTOMATED', criticality: 'CRITICAL',
      connectorConfig: {tenantId: 'contoso.onmicrosoft.com', keyVaultRef: 'kv-graph-connector'},
    });
    const mainframe = await registerApplication(pool, adminCtx, {
      name: 'Mainframe GL', ownerIdentityId: oscar.id, securityOfficerIdentityId: sam.id,
      connectorType: 'MANUAL', fulfillmentMode: 'MANUAL', criticality: 'HIGH',
    });

    const entFinanceGroup = await createEntitlement(pool, adminCtx, {
      applicationId: entraApp.id, code: 'GRP_FINANCE_REPORTING', name: 'Finance-Reporting group',
      riskLevel: 'LOW', externalRef: {entraGroupObjectId: 'grp-finance-reporting'},
    });
    const entErpAdmins = await createEntitlement(pool, adminCtx, {
      applicationId: entraApp.id, code: 'GRP_ERP_ADMINS', name: 'ERP-Admins group',
      riskLevel: 'CRITICAL', isPrivileged: true, externalRef: {entraGroupObjectId: 'grp-erp-admins'},
    });
    const entGlPost = await createEntitlement(pool, adminCtx, {
      applicationId: mainframe.id, code: 'GL_POSTINGS', name: 'GL Postings', riskLevel: 'MEDIUM',
    });
    const entGlApprove = await createEntitlement(pool, adminCtx, {
      applicationId: mainframe.id, code: 'GL_APPROVALS', name: 'GL Approvals', riskLevel: 'MEDIUM',
    });
    await pool.query(
      `INSERT INTO sod_rules (name, first_target_type, first_entitlement_id, second_target_type, second_entitlement_id, severity)
       VALUES ('GL post vs approve', 'ENTITLEMENT', $1, 'ENTITLEMENT', $2, 'BLOCK')`,
      [entGlPost.id, entGlApprove.id],
    );
    const roleAnalyst = await createBusinessRole(pool, adminCtx, {
      code: 'FIN_ANALYST', name: 'Finance Analyst', ownerIdentityId: mona.id, riskLevel: 'LOW',
    });
    await addRoleEntitlement(pool, adminCtx, roleAnalyst.id, entFinanceGroup.id);
    note('Catalog', 'Registered Entra ID (automated) + Mainframe GL (manual), 4 entitlements, role Finance Analyst, 1 SoD rule.');

    // --- 1. Joiner ---------------------------------------------------------
    const alice = await createIdentity(pool, adminCtx, {
      identityType: 'EMPLOYEE', displayName: 'Alice Analyst', primaryEmail: 'alice@contoso.com',
      department: 'Finance', jobTitle: 'Financial Analyst', managerId: mona.id, source: 'HR_FEED',
    });
    await changeIdentityStatus(pool, adminCtx, alice.id, 'ACTIVE');
    await linkIdentityAccount(pool, adminCtx, {
      identityId: alice.id, applicationId: entraApp.id,
      accountIdentifier: 'alice@contoso.com', externalRef: {objectId: 'oid-alice'},
    });
    await assignRoleToIdentity(pool, adminCtx, {
      identityId: alice.id, roleId: roleAnalyst.id, assignmentType: 'BIRTHRIGHT',
    });
    await enqueueProvisioningJobs(pool, sys);
    await runProvisioningWorker(pool, sys, registry);
    note('Joiner', 'Alice activated (JOINER event); birthright Finance Analyst expanded and provisioned into the Finance-Reporting Entra group automatically.');

    // --- 2. Self-service request with 3-stage approval ----------------------
    const in30days = new Date(Date.now() + 30 * 86_400_000);
    const {request} = await submitAccessRequest(pool, asUser(alice.id), {
      justification: 'ERP migration weekend: need temporary admin + mainframe GL postings for cutover validation',
      items: [
        {targetType: 'ENTITLEMENT', entitlementId: entErpAdmins.id, requestedExpiresAt: in30days},
        {targetType: 'ENTITLEMENT', entitlementId: entGlPost.id, requestedExpiresAt: in30days},
      ],
    });
    await decideApproval(pool, asUser(mona.id), {requestId: request.id, decision: 'APPROVED', comment: 'Needed for cutover'});
    await decideApproval(pool, asUser(oscar.id), {requestId: request.id, decision: 'APPROVED', comment: 'App owner ok'});
    await decideApproval(pool, asUser(sam.id), {requestId: request.id, decision: 'APPROVED', comment: 'Time-boxed, exception recorded'});
    note('Request', 'Alice requested privileged ERP-Admins + mainframe GL (both time-boxed exceptions). Chain manager -> app owner -> security, fulfilled on final approval.');

    // --- 3. Provisioning: automated + manual --------------------------------
    await enqueueProvisioningJobs(pool, sys);
    await runProvisioningWorker(pool, sys, registry);
    const manualQueue = await pool.query(`SELECT id FROM provisioning_jobs WHERE status = 'MANUAL_PENDING'`);
    for (const row of manualQueue.rows) {
      await confirmManualFulfillment(pool, asUser(oscar.id), row.id as string);
    }
    note('Provisioning', 'Entra job executed via Graph connector (idempotent add). Mainframe job routed to the manual queue; Oscar confirmed fulfillment (attributed evidence).');

    // --- 4. SoD block --------------------------------------------------------
    const bob = await mkPerson('Bob Bookkeeper', 'bob@contoso.com', 'Finance', 'Bookkeeper', mona.id);
    await grantTemporaryAccess(pool, adminCtx, {
      identityId: bob.id, entitlementId: entGlPost.id, expiresAt: in30days,
    });
    let sodError = '';
    try {
      await submitAccessRequest(pool, asUser(bob.id), {
        justification: 'want to approve my own postings',
        items: [{targetType: 'ENTITLEMENT', entitlementId: entGlApprove.id, requestedExpiresAt: in30days}],
      });
    } catch (err) {
      sodError = err instanceof Error ? err.message : String(err);
    }
    note('SoD', `Bob (holds GL Postings) requested GL Approvals -> BLOCKED at submission: "${sodError}"`);

    // --- 5. Expiry sweep -----------------------------------------------------
    const shortLived = await grantTemporaryAccess(pool, adminCtx, {
      identityId: bob.id, entitlementId: entFinanceGroup.id,
      expiresAt: new Date(Date.now() + 2_000),
    });
    await linkIdentityAccount(pool, adminCtx, {
      identityId: bob.id, applicationId: entraApp.id,
      accountIdentifier: 'bob@contoso.com', externalRef: {objectId: 'oid-bob'},
    });
    await enqueueProvisioningJobs(pool, sys);
    await runProvisioningWorker(pool, sys, registry);
    await sweepExpiredGrants(pool, sys, new Date(Date.now() + 10_000));
    await enqueueProvisioningJobs(pool, sys);
    await runProvisioningWorker(pool, sys, registry);
    note('Expiry', `Bob's short-lived Finance-Reporting grant lapsed; the sweep revoked it (reason EXPIRY) and the connector removed the group membership.`);
    void shortLived;

    // --- 6. Leaver -----------------------------------------------------------
    await changeIdentityStatus(pool, adminCtx, bob.id, 'LEAVING', 'resignation');
    await changeIdentityStatus(pool, adminCtx, bob.id, 'TERMINATED');
    const bobAccess = await listIdentityAccess(pool, adminCtx, bob.id);
    for (const ra of bobAccess.roles) {
      await requestRoleRevocation(pool, adminCtx, ra.id, 'LEAVER');
    }
    for (const ea of bobAccess.entitlements.filter((e) => e.sourceRoleAssignmentId === null)) {
      await requestEntitlementRevocation(pool, adminCtx, ea.id, 'LEAVER');
    }
    await enqueueProvisioningJobs(pool, sys);
    await runProvisioningWorker(pool, sys, registry);
    note('Leaver', 'Bob terminated (LEAVER events); every remaining live grant revoked with reason LEAVER and deprovisioned.');

    // --- collect final state -------------------------------------------------
    const q = async (sql: string) => (await pool.query(sql)).rows;
    const trail = await getRequestTrail(pool, userContext(iamAdmin.id, ALL), request.id);
    const output = {
      generatedAt: new Date().toISOString(),
      notes,
      identities: await q(`
        SELECT i.display_name, i.identity_type, i.department, i.job_title, i.status,
               m.display_name AS manager
        FROM identities i LEFT JOIN identities m ON m.id = i.manager_id
        ORDER BY i.created_at`),
      grants: await q(`
        SELECT i.display_name AS identity, e.name AS entitlement, a.name AS application,
               ea.assignment_type, ea.status, ea.expires_at, ea.revoked_reason,
               (ea.source_role_assignment_id IS NOT NULL) AS via_role
        FROM entitlement_assignments ea
        JOIN identities i ON i.id = ea.identity_id
        JOIN entitlements e ON e.id = ea.entitlement_id
        JOIN applications a ON a.id = e.application_id
        ORDER BY ea.created_at`),
      roleAssignments: await q(`
        SELECT i.display_name AS identity, r.name AS role, ra.assignment_type, ra.status, ra.revoked_reason
        FROM role_assignments ra
        JOIN identities i ON i.id = ra.identity_id
        JOIN business_roles r ON r.id = ra.role_id
        ORDER BY ra.created_at`),
      request: {
        justification: trail.request.justification,
        status: trail.request.status,
        approvals: await q(`
          SELECT ap.stage_order, ap.stage_type, i.display_name AS approver, ap.decision, ap.comment,
                 to_char(ap.decided_at, 'HH24:MI:SS') AS decided_at
          FROM approvals ap JOIN identities i ON i.id = ap.approver_identity_id
          ORDER BY ap.stage_order`),
      },
      policyExceptions: await q(`
        SELECT e.name AS entitlement, pe.exception_type, pe.justification,
               i.display_name AS approved_by, pe.expires_at
        FROM policy_exceptions pe
        JOIN entitlement_assignments ea ON ea.id = pe.entitlement_assignment_id
        JOIN entitlements e ON e.id = ea.entitlement_id
        JOIN identities i ON i.id = pe.approved_by_identity_id`),
      jobs: await q(`
        SELECT pj.job_type, a.name AS application, pj.connector_type, pj.status,
               pj.attempt_count, i.display_name AS manually_confirmed_by
        FROM provisioning_jobs pj
        JOIN applications a ON a.id = pj.application_id
        LEFT JOIN identities i ON i.id = pj.manual_confirmed_by_identity_id
        ORDER BY pj.created_at`),
      auditSummary: await q(`
        SELECT action, count(*)::int AS events FROM audit_events GROUP BY action ORDER BY count(*) DESC, action`),
      auditTrail: await q(`
        SELECT to_char(ae.occurred_at, 'HH24:MI:SS.MS') AS at, ae.action, ae.entity_type,
               COALESCE(i.display_name, ae.actor_type::text) AS actor
        FROM audit_events ae LEFT JOIN identities i ON i.id = ae.actor_identity_id
        ORDER BY ae.occurred_at DESC LIMIT 40`),
      entraDirectory: Object.fromEntries(
        [...directory.entries()].map(([group, members]) => [group, [...members]]),
      ),
      graphCalls: graphLog,
      totals: (await q(`
        SELECT (SELECT count(*)::int FROM identities) AS identities,
               (SELECT count(*)::int FROM entitlement_assignments WHERE status = 'ACTIVE') AS active_grants,
               (SELECT count(*)::int FROM entitlement_assignments WHERE status = 'REVOKED') AS revoked_grants,
               (SELECT count(*)::int FROM provisioning_jobs WHERE status IN ('COMPLETED','MANUAL_CONFIRMED')) AS fulfilled_jobs,
               (SELECT count(*)::int FROM audit_events) AS audit_events,
               (SELECT count(*)::int FROM policy_exceptions) AS policy_exceptions`))[0],
    };
    await writeFile(OUT, JSON.stringify(output, null, 2));
    console.log(`demo complete -> ${OUT}`);
    for (const n of notes) console.log(`  [${n.step}] ${n.detail}`);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} (FORCE)`);
    await admin.end();
  }
}

await main();
