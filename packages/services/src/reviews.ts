/**
 * Access reviews / recertification.
 *
 * A campaign snapshots the live grant ledger (scoped by application, risk
 * level, or department) at activation into per-reviewer items. Reviewers
 * certify or revoke; REVOKE decisions fire the same revocation pipeline as
 * expiry and leaver processing — a review that cannot remove access is
 * theater. Closing a campaign can auto-revoke undecided items (fail closed).
 *
 * Reviewer resolution avoids rubber stamps: a grant is never reviewed by
 * its own holder — the chain falls back manager -> app owner -> security
 * officer -> campaign creator until it finds someone else.
 */

import {
  assertTransition,
  InvariantViolation,
  reviewCampaignLifecycle,
  reviewDecisionLifecycle,
  type ReviewCampaignStatus,
  type ReviewDecision,
  type ReviewerStrategy,
  type RiskLevel,
} from '@iam/domain';
import type pg from 'pg';
import {writeAuditEvent} from './audit.js';
import {assertPermission, type AuthzContext} from './context.js';
import {
  requestEntitlementRevocationTx,
  requestRoleRevocationTx,
} from './grants.js';
import {NotFoundError} from './identities.js';
import {withTransaction} from './tx.js';

export interface CampaignScope {
  applicationIds?: string[];
  riskLevels?: RiskLevel[];
  departments?: string[];
}

export interface CreateCampaignInput {
  name: string;
  description?: string | null;
  scope?: CampaignScope;
  reviewerStrategy: ReviewerStrategy;
  dueAt?: Date | null;
  autoRevokeOnClose?: boolean;
}

export async function createReviewCampaign(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: CreateCampaignInput,
): Promise<{id: string}> {
  assertPermission(ctx, 'review:admin');
  if (ctx.actorIdentityId === null) {
    throw new InvariantViolation('HUMAN_ACTOR_REQUIRED', 'campaigns are created by people');
  }
  return withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      `INSERT INTO access_review_campaigns
         (name, description, scope, reviewer_strategy, due_at, auto_revoke_on_close, created_by_identity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.name,
        input.description ?? null,
        JSON.stringify(input.scope ?? {}),
        input.reviewerStrategy,
        input.dueAt ?? null,
        input.autoRevokeOnClose ?? false,
        ctx.actorIdentityId,
      ],
    );
    const id = (rows[0] as {id: string}).id;
    await writeAuditEvent(client, ctx, {
      action: 'review_campaign.created',
      entityType: 'review_campaign',
      entityId: id,
      afterState: input,
    });
    return {id};
  });
}

interface GrantSnapshotRow {
  grant_id: string;
  grant_kind: 'entitlement' | 'role';
  holder_id: string;
  holder_name: string;
  holder_manager_id: string | null;
  target_name: string;
  application_name: string | null;
  app_owner_id: string | null;
  app_security_officer_id: string | null;
  role_owner_id: string | null;
  assignment_type: string;
  status: string;
  expires_at: Date | null;
}

export interface ActivateCampaignResult {
  itemsCreated: number;
  skipped: Array<{grantId: string; reason: string}>;
}

export async function activateReviewCampaign(
  pool: pg.Pool,
  ctx: AuthzContext,
  campaignId: string,
): Promise<ActivateCampaignResult> {
  assertPermission(ctx, 'review:admin');

  return withTransaction(pool, async (client) => {
    const campaignRes = await client.query(
      'SELECT * FROM access_review_campaigns WHERE id = $1 FOR UPDATE',
      [campaignId],
    );
    if (campaignRes.rows.length === 0) {
      throw new NotFoundError('review_campaign', campaignId);
    }
    const campaign = campaignRes.rows[0] as Record<string, unknown>;
    assertTransition(
      reviewCampaignLifecycle,
      campaign['status'] as ReviewCampaignStatus,
      'ACTIVE',
    );
    const scope = (campaign['scope'] ?? {}) as CampaignScope;
    const strategy = campaign['reviewer_strategy'] as ReviewerStrategy;
    const creatorId = campaign['created_by_identity_id'] as string;

    // Snapshot the live ledger within scope. Entitlement grants and role
    // assignments are both reviewable; entitlement grants filter on their
    // application and risk, role assignments on the holder's department.
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const entWhere: string[] = [`ea.status IN ('PENDING_PROVISIONING','ACTIVE')`];
    if (scope.applicationIds?.length) entWhere.push(`e.application_id = ANY(${p(scope.applicationIds)})`);
    if (scope.riskLevels?.length) entWhere.push(`e.risk_level = ANY(${p(scope.riskLevels)}::risk_level[])`);
    if (scope.departments?.length) entWhere.push(`i.department = ANY(${p(scope.departments)})`);

    const grants = await client.query(
      `SELECT ea.id AS grant_id, 'entitlement' AS grant_kind,
              i.id AS holder_id, i.display_name AS holder_name, i.manager_id AS holder_manager_id,
              e.name AS target_name, a.name AS application_name,
              a.owner_identity_id AS app_owner_id,
              a.security_officer_identity_id AS app_security_officer_id,
              NULL::uuid AS role_owner_id,
              ea.assignment_type::text AS assignment_type, ea.status::text AS status, ea.expires_at
       FROM entitlement_assignments ea
       JOIN identities i ON i.id = ea.identity_id
       JOIN entitlements e ON e.id = ea.entitlement_id
       JOIN applications a ON a.id = e.application_id
       WHERE ${entWhere.join(' AND ')}
       ORDER BY ea.created_at`,
      params,
    );

    let created = 0;
    const skipped: ActivateCampaignResult['skipped'] = [];
    for (const row of grants.rows as GrantSnapshotRow[]) {
      const reviewers = resolveReviewers(strategy, row, creatorId);
      if (reviewers.length === 0) {
        skipped.push({grantId: row.grant_id, reason: 'no eligible reviewer'});
        continue;
      }
      for (const reviewerId of reviewers) {
        await client.query(
          `INSERT INTO access_review_items
             (campaign_id, entitlement_assignment_id, reviewer_identity_id, snapshot)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [
            campaignId,
            row.grant_id,
            reviewerId,
            JSON.stringify({
              holder: row.holder_name,
              target: row.target_name,
              application: row.application_name,
              assignmentType: row.assignment_type,
              status: row.status,
              expiresAt: row.expires_at,
            }),
          ],
        );
        created += 1;
      }
    }

    await client.query(
      `UPDATE access_review_campaigns SET status = 'ACTIVE', starts_at = now() WHERE id = $1`,
      [campaignId],
    );
    await writeAuditEvent(client, ctx, {
      action: 'review_campaign.activated',
      entityType: 'review_campaign',
      entityId: campaignId,
      afterState: {itemsCreated: created, skipped},
    });
    return {itemsCreated: created, skipped};
  });
}

/**
 * Reviewer chain with self-review prevention: the holder never reviews
 * their own grant; each strategy falls back until it finds someone else.
 */
function resolveReviewers(
  strategy: ReviewerStrategy,
  row: GrantSnapshotRow,
  campaignCreatorId: string,
): string[] {
  const notHolder = (id: string | null): string | null =>
    id !== null && id !== row.holder_id ? id : null;
  const managerChain =
    notHolder(row.holder_manager_id) ??
    notHolder(row.app_owner_id) ??
    notHolder(row.app_security_officer_id) ??
    notHolder(campaignCreatorId);
  const ownerChain =
    notHolder(row.app_owner_id ?? row.role_owner_id) ??
    notHolder(row.app_security_officer_id) ??
    notHolder(campaignCreatorId);

  const reviewers = new Set<string>();
  if (strategy === 'MANAGER' || strategy === 'BOTH') {
    if (managerChain !== null) reviewers.add(managerChain);
  }
  if (strategy === 'APP_OWNER' || strategy === 'BOTH') {
    if (ownerChain !== null) reviewers.add(ownerChain);
  }
  return [...reviewers];
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface DecideReviewInput {
  itemId: string;
  decision: 'CERTIFIED' | 'REVOKED';
  comment?: string;
}

export async function decideReviewItem(
  pool: pg.Pool,
  ctx: AuthzContext,
  input: DecideReviewInput,
): Promise<void> {
  assertPermission(ctx, 'review:decide');
  if (ctx.actorIdentityId === null) {
    throw new InvariantViolation('HUMAN_ACTOR_REQUIRED', 'review decisions are made by people');
  }

  await withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      'SELECT * FROM access_review_items WHERE id = $1 FOR UPDATE',
      [input.itemId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('review_item', input.itemId);
    }
    const item = rows[0] as Record<string, unknown>;
    if (item['reviewer_identity_id'] !== ctx.actorIdentityId) {
      throw new InvariantViolation('NOT_THE_REVIEWER', 'only the assigned reviewer can decide this item');
    }
    assertTransition(
      reviewDecisionLifecycle,
      item['decision'] as ReviewDecision,
      input.decision,
    );

    await client.query(
      `UPDATE access_review_items
       SET decision = $2, decided_by_identity_id = $3, decided_at = now(), comment = $4
       WHERE id = $1`,
      [input.itemId, input.decision, ctx.actorIdentityId, input.comment ?? null],
    );
    await writeAuditEvent(client, ctx, {
      action: 'review_item.decided',
      entityType: 'review_item',
      entityId: input.itemId,
      afterState: {decision: input.decision, comment: input.comment ?? null},
    });

    if (input.decision === 'REVOKED') {
      await revokeReviewedGrant(client, ctx, item);
    }
  });
}

async function revokeReviewedGrant(
  client: pg.PoolClient,
  ctx: AuthzContext,
  item: Record<string, unknown>,
): Promise<void> {
  const eaId = item['entitlement_assignment_id'] as string | null;
  const raId = item['role_assignment_id'] as string | null;
  if (eaId !== null) {
    const {rows} = await client.query('SELECT status FROM entitlement_assignments WHERE id = $1', [eaId]);
    if (rows.length > 0 && ['PENDING_PROVISIONING', 'ACTIVE'].includes(rows[0].status as string)) {
      await requestEntitlementRevocationTx(client, ctx, eaId, 'REVIEW');
    }
  } else if (raId !== null) {
    const {rows} = await client.query('SELECT status FROM role_assignments WHERE id = $1', [raId]);
    if (rows.length > 0 && ['PENDING_PROVISIONING', 'ACTIVE'].includes(rows[0].status as string)) {
      await requestRoleRevocationTx(client, ctx, raId, 'REVIEW');
    }
  }
}

export async function escalateReviewItem(
  pool: pg.Pool,
  ctx: AuthzContext,
  itemId: string,
  newReviewerIdentityId: string,
): Promise<void> {
  assertPermission(ctx, 'review:admin');

  await withTransaction(pool, async (client) => {
    const {rows} = await client.query(
      'SELECT * FROM access_review_items WHERE id = $1 FOR UPDATE',
      [itemId],
    );
    if (rows.length === 0) {
      throw new NotFoundError('review_item', itemId);
    }
    const item = rows[0] as Record<string, unknown>;
    assertTransition(reviewDecisionLifecycle, item['decision'] as ReviewDecision, 'ESCALATED');
    await client.query(
      `UPDATE access_review_items
       SET decision = 'ESCALATED', reviewer_identity_id = $2,
           decided_by_identity_id = $3, decided_at = now()
       WHERE id = $1`,
      [itemId, newReviewerIdentityId, ctx.actorIdentityId],
    );
    await writeAuditEvent(client, ctx, {
      action: 'review_item.escalated',
      entityType: 'review_item',
      entityId: itemId,
      afterState: {newReviewerIdentityId},
    });
  });
}

// ---------------------------------------------------------------------------
// Close & evidence
// ---------------------------------------------------------------------------

export interface CloseCampaignResult {
  certified: number;
  revoked: number;
  autoRevoked: number;
  undecided: number;
}

export async function closeReviewCampaign(
  pool: pg.Pool,
  ctx: AuthzContext,
  campaignId: string,
): Promise<CloseCampaignResult> {
  assertPermission(ctx, 'review:admin');
  if (ctx.actorIdentityId === null) {
    throw new InvariantViolation('HUMAN_ACTOR_REQUIRED', 'campaigns are closed by people');
  }

  return withTransaction(pool, async (client) => {
    const campaignRes = await client.query(
      'SELECT * FROM access_review_campaigns WHERE id = $1 FOR UPDATE',
      [campaignId],
    );
    if (campaignRes.rows.length === 0) {
      throw new NotFoundError('review_campaign', campaignId);
    }
    const campaign = campaignRes.rows[0] as Record<string, unknown>;
    assertTransition(reviewCampaignLifecycle, campaign['status'] as ReviewCampaignStatus, 'CLOSING');
    await client.query(
      `UPDATE access_review_campaigns SET status = 'CLOSING' WHERE id = $1`,
      [campaignId],
    );

    let autoRevoked = 0;
    if (campaign['auto_revoke_on_close'] === true) {
      const undecided = await client.query(
        `SELECT * FROM access_review_items
         WHERE campaign_id = $1 AND decision IN ('PENDING', 'ESCALATED') FOR UPDATE`,
        [campaignId],
      );
      for (const item of undecided.rows as Array<Record<string, unknown>>) {
        await client.query(
          `UPDATE access_review_items
           SET decision = 'REVOKED', decided_by_identity_id = $2, decided_at = now(),
               comment = 'auto-revoked: undecided at campaign close'
           WHERE id = $1`,
          [item['id'], ctx.actorIdentityId],
        );
        await writeAuditEvent(client, ctx, {
          action: 'review_item.decided',
          entityType: 'review_item',
          entityId: item['id'] as string,
          afterState: {decision: 'REVOKED', reason: 'auto-revoke on close'},
        });
        await revokeReviewedGrant(client, ctx, item);
        autoRevoked += 1;
      }
    }

    const counts = await client.query(
      `SELECT decision, count(*)::int AS n FROM access_review_items
       WHERE campaign_id = $1 GROUP BY decision`,
      [campaignId],
    );
    const byDecision = Object.fromEntries(counts.rows.map((r) => [r.decision, r.n as number]));

    await client.query(
      `UPDATE access_review_campaigns SET status = 'CLOSED', closed_at = now() WHERE id = $1`,
      [campaignId],
    );
    const result: CloseCampaignResult = {
      certified: byDecision['CERTIFIED'] ?? 0,
      revoked: (byDecision['REVOKED'] ?? 0) - autoRevoked,
      autoRevoked,
      undecided: (byDecision['PENDING'] ?? 0) + (byDecision['ESCALATED'] ?? 0),
    };
    await writeAuditEvent(client, ctx, {
      action: 'review_campaign.closed',
      entityType: 'review_campaign',
      entityId: campaignId,
      afterState: result,
    });
    return result;
  });
}

export async function listReviewerInbox(
  pool: pg.Pool,
  ctx: AuthzContext,
): Promise<Array<Record<string, unknown>>> {
  assertPermission(ctx, 'review:decide');
  const {rows} = await pool.query(
    `SELECT ri.id, ri.campaign_id, c.name AS campaign_name, c.due_at,
            ri.snapshot, ri.decision, ri.entitlement_assignment_id, ri.role_assignment_id
     FROM access_review_items ri
     JOIN access_review_campaigns c ON c.id = ri.campaign_id
     WHERE ri.reviewer_identity_id = $1 AND ri.decision IN ('PENDING', 'ESCALATED')
       AND c.status = 'ACTIVE'
     ORDER BY c.due_at NULLS LAST, ri.created_at`,
    [ctx.actorIdentityId],
  );
  return rows as Array<Record<string, unknown>>;
}

/** Compliance evidence pack for one campaign. */
export async function getCampaignEvidence(
  pool: pg.Pool,
  ctx: AuthzContext,
  campaignId: string,
): Promise<Record<string, unknown>> {
  assertPermission(ctx, 'review:admin');
  const campaign = await pool.query('SELECT * FROM access_review_campaigns WHERE id = $1', [campaignId]);
  if (campaign.rows.length === 0) {
    throw new NotFoundError('review_campaign', campaignId);
  }
  const items = await pool.query(
    `SELECT ri.*, r.display_name AS reviewer, d.display_name AS decided_by
     FROM access_review_items ri
     JOIN identities r ON r.id = ri.reviewer_identity_id
     LEFT JOIN identities d ON d.id = ri.decided_by_identity_id
     WHERE ri.campaign_id = $1 ORDER BY ri.created_at`,
    [campaignId],
  );
  const audit = await pool.query(
    `SELECT * FROM audit_events
     WHERE (entity_type = 'review_campaign' AND entity_id = $1)
        OR (entity_type = 'review_item' AND entity_id IN
            (SELECT id FROM access_review_items WHERE campaign_id = $1))
     ORDER BY occurred_at`,
    [campaignId],
  );
  return {campaign: campaign.rows[0], items: items.rows, auditEvents: audit.rows};
}
