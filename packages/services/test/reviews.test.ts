import {InvariantViolation} from '@iam/domain';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {Permission} from '../src/index.js';
import {
  activateGrant,
  activateReviewCampaign,
  changeIdentityStatus,
  closeReviewCampaign,
  createEntitlement,
  createIdentity,
  createReviewCampaign,
  decideReviewItem,
  escalateReviewItem,
  getCampaignEvidence,
  grantTemporaryAccess,
  listReviewerInbox,
  registerApplication,
  systemContext,
  userContext,
} from '../src/index.js';
import {createTestDb, type TestDb} from './setup.js';

let db: TestDb;
let adminId: string;
let monaId: string; // manager of alice
let aliceId: string;
let oscarId: string; // app owner
let appId: string;
let entId: string;
let otherAppId: string;
let otherEntId: string;

const FUTURE = new Date('2030-01-01T00:00:00Z');
const ADMIN_PERMS: Permission[] = [
  'identity:read', 'identity:write', 'identity:lifecycle',
  'application:write', 'entitlement:write', 'role:write', 'catalog:read',
  'grant:read', 'grant:write', 'review:admin', 'review:decide',
];

const admin = () => userContext(adminId, ADMIN_PERMS);
const as = (id: string) => userContext(id, ['review:decide']);

async function newActiveUser(name: string, managerId?: string): Promise<string> {
  const identity = await createIdentity(db.pool, admin(), {
    identityType: 'EMPLOYEE',
    displayName: name,
    primaryEmail: `${name.toLowerCase().replaceAll(' ', '.')}@corp.example.com`,
    managerId: managerId ?? null,
    department: 'Finance',
  });
  await changeIdentityStatus(db.pool, admin(), identity.id, 'ACTIVE');
  return identity.id;
}

async function activeGrantFor(identityId: string, entitlementId: string): Promise<string> {
  const grant = await grantTemporaryAccess(db.pool, admin(), {
    identityId,
    entitlementId,
    expiresAt: FUTURE,
  });
  await activateGrant(db.pool, admin(), 'entitlement_assignments', grant.id);
  return grant.id;
}

beforeAll(async () => {
  db = await createTestDb('iam_svc_reviews');
  adminId = (
    await createIdentity(db.pool, systemContext(), {
      identityType: 'EMPLOYEE',
      displayName: 'Review Admin',
      primaryEmail: 'review-admin@corp.example.com',
    })
  ).id;
  monaId = await newActiveUser('Mona Manager');
  aliceId = await newActiveUser('Alice Holder', monaId);
  oscarId = await newActiveUser('Oscar Owner', monaId);
  appId = (
    await registerApplication(db.pool, admin(), {name: 'ERP', ownerIdentityId: oscarId})
  ).id;
  entId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: appId, code: 'ERP_VIEW', name: 'View ERP', riskLevel: 'HIGH',
    })
  ).id;
  otherAppId = (
    await registerApplication(db.pool, admin(), {name: 'CRM', ownerIdentityId: oscarId})
  ).id;
  otherEntId = (
    await createEntitlement(db.pool, admin(), {
      applicationId: otherAppId, code: 'CRM_VIEW', name: 'View CRM',
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('campaign activation and scoping', () => {
  it('snapshots only in-scope grants and assigns the holder’s manager as reviewer', async () => {
    const grantId = await activeGrantFor(aliceId, entId);
    await activeGrantFor(aliceId, otherEntId); // out of scope

    const {id: campaignId} = await createReviewCampaign(db.pool, admin(), {
      name: 'Q3 ERP review',
      scope: {applicationIds: [appId]},
      reviewerStrategy: 'MANAGER',
    });
    const activation = await activateReviewCampaign(db.pool, admin(), campaignId);
    expect(activation.itemsCreated).toBe(1);

    const inbox = await listReviewerInbox(db.pool, as(monaId));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      campaign_name: 'Q3 ERP review',
      entitlement_assignment_id: grantId,
    });
    expect(inbox[0]!['snapshot']).toMatchObject({holder: 'Alice Holder', target: 'View ERP'});

    // Certify to clean up for later tests.
    await decideReviewItem(db.pool, as(monaId), {
      itemId: inbox[0]!['id'] as string,
      decision: 'CERTIFIED',
      comment: 'still needed',
    });
  });

  it('never assigns the holder as their own reviewer (falls back to the app owner)', async () => {
    // Mona has no manager, so a MANAGER campaign over Mona's grant falls back.
    await activeGrantFor(monaId, entId);
    const {id: campaignId} = await createReviewCampaign(db.pool, admin(), {
      name: 'Managerless review',
      scope: {applicationIds: [appId]},
      reviewerStrategy: 'MANAGER',
    });
    await activateReviewCampaign(db.pool, admin(), campaignId);
    const oscarInbox = await listReviewerInbox(db.pool, as(oscarId));
    const monasGrantItem = oscarInbox.find(
      (i) => (i['snapshot'] as Record<string, unknown>)['holder'] === 'Mona Manager',
    );
    expect(monasGrantItem).toBeDefined();
    await decideReviewItem(db.pool, as(oscarId), {
      itemId: monasGrantItem!['id'] as string,
      decision: 'CERTIFIED',
    });
    // Alice's grant in this campaign goes to Mona (her manager) as usual.
    const monaInbox = await listReviewerInbox(db.pool, as(monaId));
    for (const item of monaInbox) {
      await decideReviewItem(db.pool, as(monaId), {itemId: item['id'] as string, decision: 'CERTIFIED'});
    }
  });
});

describe('decisions', () => {
  it('REVOKE decisions push the grant into the revocation pipeline with reason REVIEW', async () => {
    const bobId = await newActiveUser('Bob Reviewed', monaId);
    const grantId = await activeGrantFor(bobId, entId);
    const {id: campaignId} = await createReviewCampaign(db.pool, admin(), {
      name: 'Revoking review',
      scope: {applicationIds: [appId]},
      reviewerStrategy: 'MANAGER',
    });
    await activateReviewCampaign(db.pool, admin(), campaignId);

    const inbox = await listReviewerInbox(db.pool, as(monaId));
    const item = inbox.find((i) => i['entitlement_assignment_id'] === grantId)!;
    await decideReviewItem(db.pool, as(monaId), {
      itemId: item['id'] as string,
      decision: 'REVOKED',
      comment: 'no longer needed',
    });

    const {rows} = await db.pool.query(
      'SELECT status, revoked_reason FROM entitlement_assignments WHERE id = $1',
      [grantId],
    );
    expect(rows[0]).toMatchObject({status: 'PENDING_REVOCATION', revoked_reason: 'REVIEW'});

    // Certify remaining items to keep later tests clean.
    for (const rest of await listReviewerInbox(db.pool, as(monaId))) {
      await decideReviewItem(db.pool, as(monaId), {itemId: rest['id'] as string, decision: 'CERTIFIED'});
    }
  });

  it('only the assigned reviewer can decide; decisions are final', async () => {
    const carlId = await newActiveUser('Carl Held', monaId);
    const grantId = await activeGrantFor(carlId, entId);
    const {id: campaignId} = await createReviewCampaign(db.pool, admin(), {
      name: 'Strict review',
      scope: {applicationIds: [appId]},
      reviewerStrategy: 'MANAGER',
    });
    await activateReviewCampaign(db.pool, admin(), campaignId);
    const inbox = await listReviewerInbox(db.pool, as(monaId));
    const item = inbox.find((i) => i['entitlement_assignment_id'] === grantId)!;

    await expect(
      decideReviewItem(db.pool, as(oscarId), {itemId: item['id'] as string, decision: 'CERTIFIED'}),
    ).rejects.toThrowError(/assigned reviewer/);

    await decideReviewItem(db.pool, as(monaId), {itemId: item['id'] as string, decision: 'CERTIFIED'});
    await expect(
      decideReviewItem(db.pool, as(monaId), {itemId: item['id'] as string, decision: 'REVOKED'}),
    ).rejects.toThrowError(/Illegal review_item transition/);
  });

  it('escalated items are decided by the new reviewer', async () => {
    const danaId = await newActiveUser('Dana Escalated', monaId);
    const grantId = await activeGrantFor(danaId, entId);
    const {id: campaignId} = await createReviewCampaign(db.pool, admin(), {
      name: 'Escalation review',
      scope: {applicationIds: [appId]},
      reviewerStrategy: 'MANAGER',
    });
    await activateReviewCampaign(db.pool, admin(), campaignId);
    const inbox = await listReviewerInbox(db.pool, as(monaId));
    const item = inbox.find((i) => i['entitlement_assignment_id'] === grantId)!;

    await escalateReviewItem(db.pool, admin(), item['id'] as string, oscarId);
    await expect(
      decideReviewItem(db.pool, as(monaId), {itemId: item['id'] as string, decision: 'CERTIFIED'}),
    ).rejects.toThrowError(/assigned reviewer/);
    await decideReviewItem(db.pool, as(oscarId), {itemId: item['id'] as string, decision: 'CERTIFIED'});
  });
});

describe('campaign close and evidence', () => {
  it('auto-revokes undecided items on close when configured (fail closed)', async () => {
    const evanId = await newActiveUser('Evan Undecided', monaId);
    const grantId = await activeGrantFor(evanId, entId);
    const {id: campaignId} = await createReviewCampaign(db.pool, admin(), {
      name: 'Fail-closed review',
      scope: {applicationIds: [appId]},
      reviewerStrategy: 'MANAGER',
      autoRevokeOnClose: true,
    });
    await activateReviewCampaign(db.pool, admin(), campaignId);

    const result = await closeReviewCampaign(db.pool, admin(), campaignId);
    expect(result.autoRevoked).toBeGreaterThanOrEqual(1);
    expect(result.undecided).toBe(0);

    const {rows} = await db.pool.query(
      'SELECT status, revoked_reason FROM entitlement_assignments WHERE id = $1',
      [grantId],
    );
    expect(rows[0]).toMatchObject({status: 'PENDING_REVOCATION', revoked_reason: 'REVIEW'});

    const evidence = await getCampaignEvidence(db.pool, admin(), campaignId);
    expect((evidence['campaign'] as Record<string, unknown>)['status']).toBe('CLOSED');
    const items = evidence['items'] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((i) => i['decided_at'] !== null)).toBe(true);
    const auditActions = (evidence['auditEvents'] as Array<Record<string, unknown>>).map((e) => e['action']);
    expect(auditActions).toContain('review_campaign.created');
    expect(auditActions).toContain('review_campaign.activated');
    expect(auditActions).toContain('review_item.decided');
    expect(auditActions).toContain('review_campaign.closed');
  });

  it('requires human actors and the review:admin permission', async () => {
    await expect(
      createReviewCampaign(db.pool, systemContext(), {name: 'x', reviewerStrategy: 'MANAGER'}),
    ).rejects.toThrowError(InvariantViolation);
    const noPerms = userContext(monaId, ['review:decide']);
    await expect(
      createReviewCampaign(db.pool, noPerms, {name: 'x', reviewerStrategy: 'MANAGER'}),
    ).rejects.toThrowError(/permission denied/);
  });
});
