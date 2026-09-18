/**
 * Lifecycle state machines for the IAM domain.
 *
 * Services MUST route every status change through assertTransition() so that
 * illegal jumps (e.g. TERMINATED -> ACTIVE, REVOKED -> ACTIVE) are impossible
 * regardless of which API or worker performs the write.
 */

import type {
  GrantStatus,
  IdentityStatus,
  ProvisioningJobStatus,
  RequestStatus,
  ReviewCampaignStatus,
  ReviewDecision,
} from './enums.js';

export class IllegalTransitionError extends Error {
  constructor(
    public readonly machine: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export interface StateMachine<S extends string> {
  name: string;
  transitions: Readonly<Record<S, readonly S[]>>;
}

export function canTransition<S extends string>(machine: StateMachine<S>, from: S, to: S): boolean {
  return machine.transitions[from].includes(to);
}

export function assertTransition<S extends string>(machine: StateMachine<S>, from: S, to: S): void {
  if (!canTransition(machine, from, to)) {
    throw new IllegalTransitionError(machine.name, from, to);
  }
}

export function isTerminal<S extends string>(machine: StateMachine<S>, state: S): boolean {
  return machine.transitions[state].length === 0;
}

/**
 * Identity lifecycle (Joiner / Mover / Leaver).
 *
 *  PENDING     joiner created, not yet started
 *  ACTIVE      working; access allowed
 *  SUSPENDED   temporarily blocked (leave of absence, investigation)
 *  LEAVING     notice period; termination scheduled
 *  TERMINATED  terminal. Rehire = new JOINER event, never reactivation.
 */
export const identityLifecycle: StateMachine<IdentityStatus> = {
  name: 'identity',
  transitions: {
    PENDING: ['ACTIVE', 'TERMINATED'],
    ACTIVE: ['SUSPENDED', 'LEAVING', 'TERMINATED'],
    SUSPENDED: ['ACTIVE', 'LEAVING', 'TERMINATED'],
    LEAVING: ['ACTIVE', 'TERMINATED'], // ACTIVE = rescinded resignation
    TERMINATED: [],
  },
};

/**
 * Grant lifecycle — shared by role_assignments and entitlement_assignments.
 * Status only advances when the corresponding provisioning job completes.
 */
export const grantLifecycle: StateMachine<GrantStatus> = {
  name: 'grant',
  transitions: {
    PENDING_PROVISIONING: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['PENDING_REVOCATION'],
    PENDING_REVOCATION: ['REVOKED'],
    REVOKED: [],
    CANCELLED: [],
  },
};

/** Access request lifecycle. */
export const requestLifecycle: StateMachine<RequestStatus> = {
  name: 'access_request',
  transitions: {
    DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
    PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED: ['PROVISIONED'],
    REJECTED: [],
    CANCELLED: [],
    PROVISIONED: [],
  },
};

/**
 * Provisioning job lifecycle. FAILED -> QUEUED is the retry path;
 * MANUAL_PENDING is the manual-fulfillment fallback queue.
 */
export const provisioningJobLifecycle: StateMachine<ProvisioningJobStatus> = {
  name: 'provisioning_job',
  transitions: {
    QUEUED: ['RUNNING', 'MANUAL_PENDING', 'CANCELLED'],
    RUNNING: ['COMPLETED', 'FAILED', 'MANUAL_PENDING'],
    FAILED: ['QUEUED', 'CANCELLED'],
    MANUAL_PENDING: ['MANUAL_CONFIRMED', 'CANCELLED'],
    COMPLETED: [],
    MANUAL_CONFIRMED: [],
    CANCELLED: [],
  },
};

/** Access review campaign lifecycle. */
export const reviewCampaignLifecycle: StateMachine<ReviewCampaignStatus> = {
  name: 'review_campaign',
  transitions: {
    DRAFT: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['CLOSING', 'CANCELLED'],
    CLOSING: ['CLOSED'],
    CLOSED: [],
    CANCELLED: [],
  },
};

/** Review item decision flow. ESCALATED items still need a final human decision. */
export const reviewDecisionLifecycle: StateMachine<ReviewDecision> = {
  name: 'review_item',
  transitions: {
    PENDING: ['CERTIFIED', 'REVOKED', 'ESCALATED'],
    ESCALATED: ['CERTIFIED', 'REVOKED'],
    CERTIFIED: [],
    REVOKED: [],
  },
};
