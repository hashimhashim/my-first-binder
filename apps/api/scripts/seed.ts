/**
 * Seeds the app database with an in-flight scenario so every view has real,
 * actionable content:
 *   - Alice holds birthright access (provisioned)
 *   - one request is waiting at Mona's manager stage
 *   - one fulfilled request left a mainframe job in the manual queue for Oscar
 *   - an active review campaign has items in Mona's review inbox
 *
 * DATABASE_URL must point at the postgres admin DB; the script (re)creates
 * the database named by APP_DB (default iam_app).
 */

import {runMigrations} from '@iam/db';
import {
  addRoleEntitlement,
  activateReviewCampaign,
  assignRoleToIdentity,
  changeIdentityStatus,
  ConnectorRegistry,
  createBusinessRole,
  createEntitlement,
  createIdentity,
  createReviewCampaign,
  decideApproval,
  enqueueProvisioningJobs,
  grantTemporaryAccess,
  linkIdentityAccount,
  registerApplication,
  runProvisioningWorker,
  submitAccessRequest,
  systemContext,
  userContext,
  type Connector,
  type Permission,
} from '@iam/services';
import pg from 'pg';

const ADMIN_URL = process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const APP_DB = process.env['APP_DB'] ?? 'iam_app';

const ALL: Permission[] = [
  'identity:read', 'identity:write', 'identity:lifecycle',
  'application:read', 'application:write', 'catalog:read', 'entitlement:write', 'role:write',
  'grant:read', 'grant:write', 'request:read', 'request:submit', 'request:approve',
  'provisioning:read', 'provisioning:write', 'provisioning:confirm', 'review:admin', 'review:decide',
];
const asUser = (id: string) => userContext(id, ['request:read', 'request:submit', 'request:approve']);

const devConnector: Connector = {type: 'ENTRA_GRAPH', execute: async () => ({ok: true})};
const registry = new ConnectorRegistry().register(devConnector);

const admin = new pg.Client({connectionString: ADMIN_URL});
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${APP_DB} (FORCE)`);
await admin.query(`CREATE DATABASE ${APP_DB}`);
await admin.end();

const url = new URL(ADMIN_URL);
url.pathname = `/${APP_DB}`;
const migrator = new pg.Client({connectionString: url.toString()});
await migrator.connect();
await runMigrations(migrator);
await migrator.end();
const pool = new pg.Pool({connectionString: url.toString(), max: 5});
const sys = systemContext();

// --- org ---------------------------------------------------------------
const iamAdmin = await createIdentity(pool, sys, {
  identityType: 'EMPLOYEE', displayName: 'IAM Platform Admin',
  primaryEmail: 'iam-admin@contoso.com', department: 'Security', jobTitle: 'IAM Engineer',
});
await changeIdentityStatus(pool, sys, iamAdmin.id, 'ACTIVE');
const adminCtx = userContext(iamAdmin.id, ALL);
const person = async (name: string, email: string, dept: string, title: string, managerId?: string) => {
  const p = await createIdentity(pool, adminCtx, {
    identityType: 'EMPLOYEE', displayName: name, primaryEmail: email,
    department: dept, jobTitle: title, managerId: managerId ?? null,
  });
  await changeIdentityStatus(pool, adminCtx, p.id, 'ACTIVE');
  return p;
};
const mona = await person('Mona Manager', 'mona@contoso.com', 'Finance', 'Finance Director');
const oscar = await person('Oscar Owner', 'oscar@contoso.com', 'IT', 'Application Owner', mona.id);
const sam = await person('Sam Security', 'sam@contoso.com', 'Security', 'Security Officer', mona.id);
const alice = await person('Alice Analyst', 'alice@contoso.com', 'Finance', 'Financial Analyst', mona.id);
const bob = await person('Bob Bookkeeper', 'bob@contoso.com', 'Finance', 'Bookkeeper', mona.id);

// --- catalog -------------------------------------------------------------
const entraApp = await registerApplication(pool, adminCtx, {
  name: 'Microsoft Entra ID', ownerIdentityId: oscar.id, securityOfficerIdentityId: sam.id,
  connectorType: 'ENTRA_GRAPH', fulfillmentMode: 'AUTOMATED', criticality: 'CRITICAL',
  connectorConfig: {tenantId: 'contoso.onmicrosoft.com', keyVaultRef: 'kv-graph-connector'},
});
const mainframe = await registerApplication(pool, adminCtx, {
  name: 'Mainframe GL', ownerIdentityId: oscar.id, securityOfficerIdentityId: sam.id,
  connectorType: 'MANUAL', fulfillmentMode: 'MANUAL', criticality: 'HIGH',
});
const entFinance = await createEntitlement(pool, adminCtx, {
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
   VALUES ('GL post vs approve', 'ENTITLEMENT', $1, 'ENTITLEMENT', $2, 'REQUIRE_APPROVAL')`,
  [entGlPost.id, entGlApprove.id],
);
const roleAnalyst = await createBusinessRole(pool, adminCtx, {
  code: 'FIN_ANALYST', name: 'Finance Analyst', ownerIdentityId: mona.id, riskLevel: 'LOW',
});
await addRoleEntitlement(pool, adminCtx, roleAnalyst.id, entFinance.id);

// --- Alice: provisioned birthright + linked account -----------------------
await linkIdentityAccount(pool, adminCtx, {
  identityId: alice.id, applicationId: entraApp.id,
  accountIdentifier: 'alice@contoso.com', externalRef: {objectId: 'oid-alice'},
});
await assignRoleToIdentity(pool, adminCtx, {
  identityId: alice.id, roleId: roleAnalyst.id, assignmentType: 'BIRTHRIGHT',
});
await enqueueProvisioningJobs(pool, sys);
await runProvisioningWorker(pool, sys, registry);

// --- in-flight request waiting at Mona's stage ------------------------------
const in30 = new Date(Date.now() + 30 * 86_400_000);
await submitAccessRequest(pool, asUser(alice.id), {
  justification: 'ERP migration weekend: temporary admin access for cutover validation',
  items: [{targetType: 'ENTITLEMENT', entitlementId: entErpAdmins.id, requestedExpiresAt: in30}],
});

// --- fulfilled request leaving a manual-queue job for Oscar ------------------
const {request: bobReq} = await submitAccessRequest(pool, asUser(bob.id), {
  justification: 'Quarter close: need to post GL corrections for Q2',
  items: [{targetType: 'ENTITLEMENT', entitlementId: entGlPost.id, requestedExpiresAt: in30}],
});
await decideApproval(pool, asUser(mona.id), {requestId: bobReq.id, decision: 'APPROVED', comment: 'ok for quarter close'});
await decideApproval(pool, asUser(oscar.id), {requestId: bobReq.id, decision: 'APPROVED'});
await decideApproval(pool, asUser(sam.id), {requestId: bobReq.id, decision: 'APPROVED', comment: 'time-boxed'});
await enqueueProvisioningJobs(pool, sys);
await runProvisioningWorker(pool, sys, registry); // routes the mainframe job to MANUAL_PENDING

// --- active review campaign with items for Mona -------------------------------
const {id: campaignId} = await createReviewCampaign(pool, userContext(iamAdmin.id, ALL), {
  name: 'Q3 access recertification',
  scope: {applicationIds: [entraApp.id]},
  reviewerStrategy: 'MANAGER',
  dueAt: new Date(Date.now() + 14 * 86_400_000),
  autoRevokeOnClose: true,
});
await activateReviewCampaign(pool, userContext(iamAdmin.id, ALL), campaignId);

const counts = await pool.query(`
  SELECT (SELECT count(*) FROM identities) AS identities,
         (SELECT count(*) FROM approvals WHERE decision = 'PENDING') AS pending_approvals,
         (SELECT count(*) FROM provisioning_jobs WHERE status = 'MANUAL_PENDING') AS manual_jobs,
         (SELECT count(*) FROM access_review_items WHERE decision = 'PENDING') AS review_items,
         (SELECT count(*) FROM audit_events) AS audit_events`);
console.log(`seeded ${APP_DB}:`, counts.rows[0]);
await pool.end();
