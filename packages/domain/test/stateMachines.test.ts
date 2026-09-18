import {describe, expect, it} from 'vitest';
import {
  assertTransition,
  canTransition,
  grantLifecycle,
  identityLifecycle,
  IllegalTransitionError,
  isTerminal,
  provisioningJobLifecycle,
  requestLifecycle,
  reviewCampaignLifecycle,
  reviewDecisionLifecycle,
} from '../src/stateMachines.js';

describe('identity lifecycle', () => {
  it('allows the standard JML path', () => {
    expect(canTransition(identityLifecycle, 'PENDING', 'ACTIVE')).toBe(true);
    expect(canTransition(identityLifecycle, 'ACTIVE', 'LEAVING')).toBe(true);
    expect(canTransition(identityLifecycle, 'LEAVING', 'TERMINATED')).toBe(true);
  });

  it('allows suspension and reinstatement', () => {
    expect(canTransition(identityLifecycle, 'ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransition(identityLifecycle, 'SUSPENDED', 'ACTIVE')).toBe(true);
  });

  it('allows rescinded resignation', () => {
    expect(canTransition(identityLifecycle, 'LEAVING', 'ACTIVE')).toBe(true);
  });

  it('makes TERMINATED terminal — rehire is a new joiner, not reactivation', () => {
    expect(isTerminal(identityLifecycle, 'TERMINATED')).toBe(true);
    expect(() => assertTransition(identityLifecycle, 'TERMINATED', 'ACTIVE')).toThrow(
      IllegalTransitionError,
    );
  });

  it('rejects skipping activation', () => {
    expect(canTransition(identityLifecycle, 'PENDING', 'SUSPENDED')).toBe(false);
    expect(canTransition(identityLifecycle, 'PENDING', 'LEAVING')).toBe(false);
  });
});

describe('grant lifecycle', () => {
  it('follows provision -> active -> revocation -> revoked', () => {
    expect(canTransition(grantLifecycle, 'PENDING_PROVISIONING', 'ACTIVE')).toBe(true);
    expect(canTransition(grantLifecycle, 'ACTIVE', 'PENDING_REVOCATION')).toBe(true);
    expect(canTransition(grantLifecycle, 'PENDING_REVOCATION', 'REVOKED')).toBe(true);
  });

  it('never resurrects a revoked or cancelled grant', () => {
    expect(isTerminal(grantLifecycle, 'REVOKED')).toBe(true);
    expect(isTerminal(grantLifecycle, 'CANCELLED')).toBe(true);
    expect(() => assertTransition(grantLifecycle, 'REVOKED', 'ACTIVE')).toThrow(IllegalTransitionError);
  });

  it('cannot skip provisioning straight to revoked', () => {
    expect(canTransition(grantLifecycle, 'PENDING_PROVISIONING', 'REVOKED')).toBe(false);
    expect(canTransition(grantLifecycle, 'ACTIVE', 'REVOKED')).toBe(false);
  });
});

describe('request lifecycle', () => {
  it('requires approval before provisioning', () => {
    expect(canTransition(requestLifecycle, 'DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition(requestLifecycle, 'DRAFT', 'PENDING_APPROVAL')).toBe(true);
    expect(canTransition(requestLifecycle, 'PENDING_APPROVAL', 'APPROVED')).toBe(true);
    expect(canTransition(requestLifecycle, 'APPROVED', 'PROVISIONED')).toBe(true);
  });

  it('makes rejection terminal', () => {
    expect(isTerminal(requestLifecycle, 'REJECTED')).toBe(true);
  });
});

describe('provisioning job lifecycle', () => {
  it('supports the retry loop', () => {
    expect(canTransition(provisioningJobLifecycle, 'RUNNING', 'FAILED')).toBe(true);
    expect(canTransition(provisioningJobLifecycle, 'FAILED', 'QUEUED')).toBe(true);
  });

  it('supports manual fulfillment fallback', () => {
    expect(canTransition(provisioningJobLifecycle, 'QUEUED', 'MANUAL_PENDING')).toBe(true);
    expect(canTransition(provisioningJobLifecycle, 'MANUAL_PENDING', 'MANUAL_CONFIRMED')).toBe(true);
  });

  it('does not reopen completed jobs', () => {
    expect(isTerminal(provisioningJobLifecycle, 'COMPLETED')).toBe(true);
    expect(isTerminal(provisioningJobLifecycle, 'MANUAL_CONFIRMED')).toBe(true);
  });
});

describe('review lifecycles', () => {
  it('campaigns move draft -> active -> closing -> closed', () => {
    expect(canTransition(reviewCampaignLifecycle, 'DRAFT', 'ACTIVE')).toBe(true);
    expect(canTransition(reviewCampaignLifecycle, 'ACTIVE', 'CLOSING')).toBe(true);
    expect(canTransition(reviewCampaignLifecycle, 'CLOSING', 'CLOSED')).toBe(true);
    expect(canTransition(reviewCampaignLifecycle, 'ACTIVE', 'CLOSED')).toBe(false);
  });

  it('escalated review items still require a final human decision', () => {
    expect(canTransition(reviewDecisionLifecycle, 'PENDING', 'ESCALATED')).toBe(true);
    expect(canTransition(reviewDecisionLifecycle, 'ESCALATED', 'REVOKED')).toBe(true);
    expect(isTerminal(reviewDecisionLifecycle, 'ESCALATED')).toBe(false);
    expect(isTerminal(reviewDecisionLifecycle, 'CERTIFIED')).toBe(true);
  });
});
