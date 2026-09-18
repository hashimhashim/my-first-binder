/**
 * Ledger <-> Entra reconciliation.
 *
 * The grant ledger is the source of truth (design invariant I6); the tenant
 * is reality. This module compares them per Entra-bound entitlement and
 * reports drift in both directions:
 *
 *   ROGUE_ACCESS      a group member in Entra with no live ACTIVE grant —
 *                     access granted outside the platform, or a failed
 *                     revocation. The finding names the objectId even when
 *                     it belongs to no known identity.
 *   MISSING_ACCESS    an ACTIVE grant whose account is not in the group —
 *                     provisioning drift (job lost, member removed by hand).
 *   UNLINKED_ACCOUNT  an ACTIVE grant whose identity has no linked Entra
 *                     account for the application, so it cannot be compared.
 *
 * Findings are audited (reconciliation.drift_detected per finding, plus one
 * reconciliation.completed summary). Remediation is deliberately NOT
 * automatic: rogue access may be an emergency change and removal is a
 * governance decision — the report feeds the manual queue / review process.
 */

import {writeAuditEvent, type AuthzContext} from '@iam/services';
import {assertPermission, withTransaction} from '@iam/services';
import type pg from 'pg';
import type {GraphClient} from './graphClient.js';

export type DriftKind = 'ROGUE_ACCESS' | 'MISSING_ACCESS' | 'UNLINKED_ACCOUNT';

export interface DriftFinding {
  kind: DriftKind;
  entitlementId: string;
  entitlementCode: string;
  groupObjectId: string;
  /** Entra user objectId (rogue/missing) — null for UNLINKED_ACCOUNT. */
  memberObjectId: string | null;
  /** Platform identity, when the objectId maps to one. */
  identityId: string | null;
  identityName: string | null;
  detail: string;
}

export interface ReconciliationReport {
  startedAt: Date;
  groupsChecked: number;
  grantsChecked: number;
  findings: DriftFinding[];
}

/** Lists all member objectIds of a group, following @odata.nextLink paging. */
export async function listGroupMemberIds(graph: GraphClient, groupId: string): Promise<Set<string>> {
  const members = new Set<string>();
  let path: string | null = `/groups/${groupId}/members?$select=id&$top=100`;
  while (path !== null) {
    const response = await graph.request('GET', path);
    if (response.status !== 200) {
      throw new Error(`Graph returned ${response.status} listing members of group ${groupId}`);
    }
    const body = response.body as {value?: Array<{id?: string}>; '@odata.nextLink'?: string};
    for (const member of body.value ?? []) {
      if (typeof member.id === 'string') {
        members.add(member.id);
      }
    }
    const next = body['@odata.nextLink'];
    // nextLink is absolute; keep only the path+query relative to the base.
    path = typeof next === 'string' ? next.replace(/^https?:\/\/[^/]+\/v1\.0/, '') : null;
  }
  return members;
}

export async function reconcileEntraGroups(
  pool: pg.Pool,
  ctx: AuthzContext,
  graph: GraphClient,
): Promise<ReconciliationReport> {
  assertPermission(ctx, 'grant:read');
  const startedAt = new Date();

  // Every ACTIVE Entra-group-bound entitlement, with its expected members:
  // ACTIVE grants joined to the holder's linked account for the application.
  const {rows: entitlements} = await pool.query(
    `SELECT e.id, e.code, e.external_ref->>'entraGroupObjectId' AS group_id, e.application_id
     FROM entitlements e
     JOIN applications a ON a.id = e.application_id AND a.connector_type = 'ENTRA_GRAPH'
     WHERE e.status = 'ACTIVE' AND e.external_ref ? 'entraGroupObjectId'
     ORDER BY e.code`,
  );

  const findings: DriftFinding[] = [];
  let grantsChecked = 0;

  for (const ent of entitlements as Array<{id: string; code: string; group_id: string; application_id: string}>) {
    const {rows: grants} = await pool.query(
      `SELECT ea.id AS grant_id, i.id AS identity_id, i.display_name,
              ia.external_ref->>'objectId' AS object_id
       FROM entitlement_assignments ea
       JOIN identities i ON i.id = ea.identity_id
       LEFT JOIN identity_accounts ia
         ON ia.identity_id = ea.identity_id AND ia.application_id = $2
       WHERE ea.entitlement_id = $1 AND ea.status = 'ACTIVE'`,
      [ent.id, ent.application_id],
    );
    grantsChecked += grants.length;

    const actual = await listGroupMemberIds(graph, ent.group_id);
    const expected = new Map<string, {identityId: string; name: string}>();

    for (const grant of grants as Array<{identity_id: string; display_name: string; object_id: string | null}>) {
      if (grant.object_id === null) {
        findings.push({
          kind: 'UNLINKED_ACCOUNT',
          entitlementId: ent.id,
          entitlementCode: ent.code,
          groupObjectId: ent.group_id,
          memberObjectId: null,
          identityId: grant.identity_id,
          identityName: grant.display_name,
          detail: `ACTIVE grant held by ${grant.display_name} cannot be verified: no linked Entra account`,
        });
        continue;
      }
      expected.set(grant.object_id, {identityId: grant.identity_id, name: grant.display_name});
      if (!actual.has(grant.object_id)) {
        findings.push({
          kind: 'MISSING_ACCESS',
          entitlementId: ent.id,
          entitlementCode: ent.code,
          groupObjectId: ent.group_id,
          memberObjectId: grant.object_id,
          identityId: grant.identity_id,
          identityName: grant.display_name,
          detail: `ledger says ${grant.display_name} holds ${ent.code}, but they are not in group ${ent.group_id}`,
        });
      }
    }

    for (const memberId of actual) {
      if (!expected.has(memberId)) {
        const known = await pool.query(
          `SELECT i.id, i.display_name FROM identities i
           JOIN identity_accounts ia ON ia.identity_id = i.id
           WHERE ia.external_ref->>'objectId' = $1 LIMIT 1`,
          [memberId],
        );
        const identity = known.rows[0] as {id: string; display_name: string} | undefined;
        findings.push({
          kind: 'ROGUE_ACCESS',
          entitlementId: ent.id,
          entitlementCode: ent.code,
          groupObjectId: ent.group_id,
          memberObjectId: memberId,
          identityId: identity?.id ?? null,
          identityName: identity?.display_name ?? null,
          detail: `${identity?.display_name ?? `unknown object ${memberId}`} is in group ${ent.group_id} with no live grant for ${ent.code}`,
        });
      }
    }
  }

  await withTransaction(pool, async (client) => {
    for (const finding of findings) {
      await writeAuditEvent(client, ctx, {
        action: 'reconciliation.drift_detected',
        entityType: 'entitlement',
        entityId: finding.entitlementId,
        afterState: finding,
      });
    }
    await writeAuditEvent(client, ctx, {
      action: 'reconciliation.completed',
      entityType: 'reconciliation',
      afterState: {
        startedAt,
        groupsChecked: entitlements.length,
        grantsChecked,
        findingCount: findings.length,
        byKind: {
          ROGUE_ACCESS: findings.filter((f) => f.kind === 'ROGUE_ACCESS').length,
          MISSING_ACCESS: findings.filter((f) => f.kind === 'MISSING_ACCESS').length,
          UNLINKED_ACCOUNT: findings.filter((f) => f.kind === 'UNLINKED_ACCOUNT').length,
        },
      },
    });
  });

  return {startedAt, groupsChecked: entitlements.length, grantsChecked, findings};
}
