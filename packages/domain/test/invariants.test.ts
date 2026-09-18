import {describe, expect, it} from 'vitest';
import {
  assertEntitlementAssignmentExpiry,
  assertEntitlementAssignmentSource,
  assertIdentityShape,
  assertNoSelfApproval,
  assertRoleAssignmentExpiry,
  entitlementAssignmentRequiresExpiry,
  InvariantViolation,
  roleAssignmentRequiresExpiry,
} from '../src/invariants.js';

const NOW = new Date('2026-07-03T12:00:00Z');
const LATER = new Date('2026-08-01T00:00:00Z');
const EARLIER = new Date('2026-06-01T00:00:00Z');

describe('expiry rules', () => {
  it('temporary and exception grants always require expiry', () => {
    expect(roleAssignmentRequiresExpiry('TEMPORARY')).toBe(true);
    expect(roleAssignmentRequiresExpiry('BIRTHRIGHT')).toBe(false);
    expect(roleAssignmentRequiresExpiry('REQUESTED')).toBe(false);
    expect(entitlementAssignmentRequiresExpiry('TEMPORARY')).toBe(true);
    expect(entitlementAssignmentRequiresExpiry('EXCEPTION')).toBe(true);
    expect(entitlementAssignmentRequiresExpiry('ROLE_DERIVED')).toBe(false);
  });

  it('rejects a temporary role assignment without expiry', () => {
    expect(() =>
      assertRoleAssignmentExpiry('TEMPORARY', {expiresAt: null, startsAt: NOW}),
    ).toThrowError(InvariantViolation);
  });

  it('rejects an exception grant without expiry', () => {
    expect(() =>
      assertEntitlementAssignmentExpiry('EXCEPTION', {expiresAt: null, startsAt: NOW}),
    ).toThrowError(/expiry/);
  });

  it('rejects expiry before start or in the past', () => {
    expect(() =>
      assertEntitlementAssignmentExpiry('TEMPORARY', {expiresAt: EARLIER, startsAt: NOW}),
    ).toThrowError(/after startsAt/);
    expect(() =>
      assertEntitlementAssignmentExpiry('TEMPORARY', {
        expiresAt: new Date(NOW.getTime() - 1000),
        startsAt: EARLIER,
        now: NOW,
      }),
    ).toThrowError(/future/);
  });

  it('accepts a valid temporary grant and a permanent role-derived grant', () => {
    expect(() =>
      assertEntitlementAssignmentExpiry('TEMPORARY', {expiresAt: LATER, startsAt: NOW, now: NOW}),
    ).not.toThrow();
    expect(() =>
      assertEntitlementAssignmentExpiry('ROLE_DERIVED', {expiresAt: null, startsAt: NOW}),
    ).not.toThrow();
  });
});

describe('grant source rules', () => {
  it('role-derived grants must reference their source role assignment', () => {
    expect(() => assertEntitlementAssignmentSource('ROLE_DERIVED', null)).toThrowError(
      InvariantViolation,
    );
    expect(() => assertEntitlementAssignmentSource('ROLE_DERIVED', 'ra-1')).not.toThrow();
  });

  it('exception and temporary grants must not claim a role source', () => {
    expect(() => assertEntitlementAssignmentSource('EXCEPTION', 'ra-1')).toThrowError(
      /must not reference/,
    );
    expect(() => assertEntitlementAssignmentSource('TEMPORARY', null)).not.toThrow();
  });
});

describe('approval rules', () => {
  it('blocks self-approval', () => {
    expect(() => assertNoSelfApproval('id-1', 'id-1')).toThrowError(/cannot approve/);
    expect(() => assertNoSelfApproval('id-1', 'id-2')).not.toThrow();
  });
});

describe('identity shape rules', () => {
  const base = {
    primaryEmail: 'user@example.com',
    terminationDate: null,
    sponsorIdentityId: null,
    linkedIdentityId: null,
  };

  it('accepts a plain employee', () => {
    expect(() => assertIdentityShape({...base, identityType: 'EMPLOYEE'})).not.toThrow();
  });

  it('requires email for employees and contractors', () => {
    expect(() =>
      assertIdentityShape({...base, identityType: 'EMPLOYEE', primaryEmail: null}),
    ).toThrowError(/email/);
  });

  it('requires a contract end date for contractors', () => {
    expect(() => assertIdentityShape({...base, identityType: 'CONTRACTOR'})).toThrowError(
      /termination/,
    );
    expect(() =>
      assertIdentityShape({...base, identityType: 'CONTRACTOR', terminationDate: LATER}),
    ).not.toThrow();
  });

  it('requires a sponsor for service accounts', () => {
    expect(() =>
      assertIdentityShape({...base, identityType: 'SERVICE', primaryEmail: null}),
    ).toThrowError(/sponsor/i);
    expect(() =>
      assertIdentityShape({
        ...base,
        identityType: 'SERVICE',
        primaryEmail: null,
        sponsorIdentityId: 'id-9',
      }),
    ).not.toThrow();
  });

  it('requires privileged alt-accounts to link to a standard identity', () => {
    expect(() => assertIdentityShape({...base, identityType: 'PRIVILEGED'})).toThrowError(/link/);
    expect(() =>
      assertIdentityShape({...base, identityType: 'PRIVILEGED', linkedIdentityId: 'id-2'}),
    ).not.toThrow();
  });
});
