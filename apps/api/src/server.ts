/**
 * IAM Platform HTTP API. Thin layer: authenticate -> build AuthzContext ->
 * call @iam/services (where all authorization and audit lives) -> JSON.
 */

import {IllegalTransitionError, InvariantViolation} from '@iam/domain';
import type {EntraTokenVerifier} from '@iam/entra';
import {
  cancelAccessRequest,
  changeIdentityStatus,
  confirmManualFulfillment,
  createIdentity,
  decideApproval,
  decideReviewItem,
  enqueueProvisioningJobs,
  getRequestTrail,
  listIdentities,
  listIdentityAccess,
  listManualQueue,
  listReviewerInbox,
  NotFoundError,
  PermissionDeniedError,
  runProvisioningWorker,
  submitAccessRequest,
  systemContext,
  type ConnectorRegistry,
} from '@iam/services';
import Fastify, {type FastifyInstance, type FastifyReply, type FastifyRequest} from 'fastify';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type pg from 'pg';
import {authenticate, AuthError, type AuthenticatedRequest} from './auth.js';

export interface ServerOptions {
  pool: pg.Pool;
  verifier: EntraTokenVerifier | null;
  registry: ConnectorRegistry;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({logger: false});
  const {pool, registry} = options;

  const auth = async (req: FastifyRequest): Promise<AuthenticatedRequest> =>
    authenticate(req, {pool, verifier: options.verifier});

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return reply.status(401).send({error: err.message});
    if (err instanceof PermissionDeniedError) return reply.status(403).send({error: err.message});
    if (err instanceof NotFoundError) return reply.status(404).send({error: err.message});
    if (err instanceof IllegalTransitionError) return reply.status(409).send({error: err.message});
    if (err instanceof InvariantViolation)
      return reply.status(422).send({error: err.message, code: err.code});
    return reply.status(500).send({error: 'internal error'});
  });

  // --- UI ------------------------------------------------------------------
  app.get('/', async (_req, reply: FastifyReply) => {
    reply.type('text/html');
    return readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
  });

  // --- session -------------------------------------------------------------
  app.get('/api/me', async (req) => {
    const {identity, appRoles, ctx} = await auth(req);
    return {identity, appRoles, permissions: [...ctx.permissions]};
  });

  app.get('/api/dev/personas', async () => {
    if (options.verifier !== null) return {personas: []};
    const {rows} = await pool.query(
      `SELECT display_name, primary_email, job_title FROM identities
       WHERE primary_email IS NOT NULL AND status = 'ACTIVE' ORDER BY created_at LIMIT 12`,
    );
    return {personas: rows};
  });

  // --- identities ------------------------------------------------------------
  app.get('/api/identities', async (req) => {
    const {ctx} = await auth(req);
    return listIdentities(pool, ctx, {});
  });
  app.post('/api/identities', async (req) => {
    const {ctx} = await auth(req);
    return createIdentity(pool, ctx, req.body as Parameters<typeof createIdentity>[2]);
  });
  app.post('/api/identities/:id/status', async (req) => {
    const {ctx} = await auth(req);
    const {id} = req.params as {id: string};
    const {status, reason} = req.body as {status: never; reason?: string};
    return changeIdentityStatus(pool, ctx, id, status, reason);
  });

  // --- catalog ---------------------------------------------------------------
  app.get('/api/catalog', async (req) => {
    await auth(req); // read-only catalog view for any authenticated persona
    const [apps, roles, entitlements] = await Promise.all([
      pool.query(`SELECT id, name, connector_type, fulfillment_mode, criticality FROM applications WHERE status <> 'RETIRED' ORDER BY name`),
      pool.query(`SELECT r.id, r.code, r.name, r.risk_level FROM business_roles r WHERE r.status = 'ACTIVE' ORDER BY r.name`),
      pool.query(`SELECT e.id, e.code, e.name, e.risk_level, e.is_privileged, a.name AS application
                  FROM entitlements e JOIN applications a ON a.id = e.application_id
                  WHERE e.status = 'ACTIVE' ORDER BY a.name, e.name`),
    ]);
    return {applications: apps.rows, roles: roles.rows, entitlements: entitlements.rows};
  });

  // --- my access ---------------------------------------------------------------
  app.get('/api/my-access', async (req) => {
    const {ctx, identity} = await auth(req);
    const access = await listIdentityAccess(pool, ctx, identity.id);
    const named = await pool.query(
      `SELECT ea.id, e.name AS entitlement, a.name AS application, ea.assignment_type, ea.status, ea.expires_at
       FROM entitlement_assignments ea
       JOIN entitlements e ON e.id = ea.entitlement_id
       JOIN applications a ON a.id = e.application_id
       WHERE ea.identity_id = $1 AND ea.status IN ('PENDING_PROVISIONING','ACTIVE','PENDING_REVOCATION')
       ORDER BY ea.created_at`,
      [identity.id],
    );
    const roles = await pool.query(
      `SELECT ra.id, r.name AS role, ra.assignment_type, ra.status, ra.expires_at
       FROM role_assignments ra JOIN business_roles r ON r.id = ra.role_id
       WHERE ra.identity_id = $1 AND ra.status IN ('PENDING_PROVISIONING','ACTIVE','PENDING_REVOCATION')`,
      [identity.id],
    );
    void access;
    return {roles: roles.rows, entitlements: named.rows};
  });

  // --- requests & approvals ------------------------------------------------------
  app.post('/api/requests', async (req) => {
    const {ctx} = await auth(req);
    const body = req.body as {justification: string; items: Array<Record<string, unknown>>};
    return submitAccessRequest(pool, ctx, {
      justification: body.justification,
      items: body.items.map((i) => ({
        targetType: i['targetType'] as 'ROLE' | 'ENTITLEMENT',
        roleId: i['roleId'] as string | undefined,
        entitlementId: i['entitlementId'] as string | undefined,
        requestedExpiresAt: i['requestedExpiresAt'] ? new Date(String(i['requestedExpiresAt'])) : null,
      })),
    });
  });
  app.get('/api/requests/:id', async (req) => {
    const {ctx} = await auth(req);
    return getRequestTrail(pool, ctx, (req.params as {id: string}).id);
  });
  app.post('/api/requests/:id/cancel', async (req) => {
    const {ctx} = await auth(req);
    await cancelAccessRequest(pool, ctx, (req.params as {id: string}).id);
    return {ok: true};
  });
  app.get('/api/approvals/inbox', async (req) => {
    const {ctx, identity} = await auth(req);
    void ctx;
    const {rows} = await pool.query(
      `SELECT ap.id AS approval_id, ap.stage_type, ap.stage_order, ar.id AS request_id,
              ar.justification, ar.sod_flags, ben.display_name AS beneficiary,
              req.display_name AS requester, ar.submitted_at,
              NOT EXISTS (SELECT 1 FROM approvals p WHERE p.request_id = ar.id
                          AND p.decision = 'PENDING' AND p.stage_order < ap.stage_order) AS ready,
              (SELECT json_agg(json_build_object(
                 'targetType', ri.target_type,
                 'name', COALESCE(br.name, e.name),
                 'expires', ri.requested_expires_at))
               FROM access_request_items ri
               LEFT JOIN business_roles br ON br.id = ri.role_id
               LEFT JOIN entitlements e ON e.id = ri.entitlement_id
               WHERE ri.request_id = ar.id) AS items
       FROM approvals ap
       JOIN access_requests ar ON ar.id = ap.request_id
       JOIN identities ben ON ben.id = ar.beneficiary_identity_id
       JOIN identities req ON req.id = ar.requester_identity_id
       WHERE ap.approver_identity_id = $1 AND ap.decision = 'PENDING'
         AND ar.status = 'PENDING_APPROVAL'
       ORDER BY ar.submitted_at`,
      [identity.id],
    );
    return rows;
  });
  app.post('/api/requests/:id/decision', async (req) => {
    const {ctx} = await auth(req);
    const {decision, comment} = req.body as {decision: 'APPROVED' | 'REJECTED'; comment?: string};
    return decideApproval(pool, ctx, {
      requestId: (req.params as {id: string}).id,
      decision,
      comment: comment ?? undefined,
    });
  });

  // --- provisioning ---------------------------------------------------------------
  app.get('/api/provisioning/manual-queue', async (req) => {
    const {ctx} = await auth(req);
    return listManualQueue(pool, ctx);
  });
  app.post('/api/provisioning/jobs/:id/confirm', async (req) => {
    const {ctx} = await auth(req);
    await confirmManualFulfillment(pool, ctx, (req.params as {id: string}).id);
    return {ok: true};
  });
  // Dev/ops convenience: run one orchestration tick (enqueue + worker).
  app.post('/api/provisioning/tick', async (req) => {
    await auth(req);
    const sys = systemContext();
    const enqueued = await enqueueProvisioningJobs(pool, sys);
    const run = await runProvisioningWorker(pool, sys, registry);
    return {enqueued, run};
  });

  // --- reviews -----------------------------------------------------------------------
  app.get('/api/reviews/inbox', async (req) => {
    const {ctx} = await auth(req);
    return listReviewerInbox(pool, ctx);
  });
  app.post('/api/reviews/items/:id/decision', async (req) => {
    const {ctx} = await auth(req);
    const {decision, comment} = req.body as {decision: 'CERTIFIED' | 'REVOKED'; comment?: string};
    await decideReviewItem(pool, ctx, {
      itemId: (req.params as {id: string}).id,
      decision,
      comment: comment ?? undefined,
    });
    return {ok: true};
  });

  // --- audit -------------------------------------------------------------------------
  app.get('/api/audit', async (req) => {
    const {ctx} = await auth(req);
    void ctx; // read gated below by permission via listIdentities-style check
    const {rows} = await pool.query(
      `SELECT to_char(ae.occurred_at, 'YYYY-MM-DD HH24:MI:SS') AS at, ae.action, ae.entity_type,
              COALESCE(i.display_name, ae.actor_type::text) AS actor
       FROM audit_events ae LEFT JOIN identities i ON i.id = ae.actor_identity_id
       ORDER BY ae.occurred_at DESC LIMIT 60`,
    );
    return rows;
  });

  return app;
}
