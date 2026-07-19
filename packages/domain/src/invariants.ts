/**
 * Domain invariants for critical IAM rules.
 *
 * Each of these is ALSO enforced by a database constraint or trigger where
 * possible (see @iam/db migrations); the functions here give services a
 * single, typed pre-check with readable errors, and cover rules the DB
 * cannot express declaratively.
 */

import type {
  EntitlementAssignmentType,
  IdentityType,
  RoleAssignmentType,
} from './enums.js';

export class InvariantViolation extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

// ---------------------------------------------------------------------------
// Expiry rules (working rule 8: temporary access always expires)
// ---------------------------------------------------------------------------

/** Role assignment types that must carry an expiry date. */
export function roleAssignmentRequiresExpiry(type: RoleAssignmentType): boolean {
  return type === 'TEMPORARY';
}

/** Entitlement assignment types that must carry an expiry date. */
export function entitlementAssignmentRequiresExpiry(type: EntitlementAssignmentType): boolean {
  return type === 'EXCEPTION' || type === 'TEMPORARY';
}

export interface ExpiryCheckInput {
  expiresAt: Date | null;
  startsAt: Date;
  now?: Date;
}

export function assertRoleAssignmentExpiry(type: RoleAssignmentType, input: ExpiryCheckInput): void {
  assertExpiry('role_assignment', roleAssignmentRequiresExpiry(type), input);
}

export function assertEntitlementAssignmentExpiry(
  type: EntitlementAssignmentType,
  input: ExpiryCheckInput,
): void {
  assertExpiry('entitlement_assignment', entitlementAssignmentRequiresExpiry(type), input);
}

function assertExpiry(entity: string, required: boolean, {expiresAt, startsAt, now}: ExpiryCheckInput): void {
  if (required && expiresAt === null) {
    throw new InvariantViolation(
      'EXPIRY_REQUIRED',
      `${entity}: temporary/exception access must have an expiry date`,
    );
  }
  if (expiresAt !== null) {
    if (expiresAt <= startsAt) {
      throw new InvariantViolation('EXPIRY_BEFORE_START', `${entity}: expiresAt must be after startsAt`);
    }
    if (now !== undefined && expiresAt <= now) {
      throw new InvariantViolation('EXPIRY_IN_PAST', `${entity}: expiresAt must be in the future`);
    }
  }
}

// ---------------------------------------------------------------------------
// Grant source rules (working rule 9: roles vs entitlements stay separate)
// ---------------------------------------------------------------------------

export function assertEntitlementAssignmentSource(
  type: EntitlementAssignmentType,
  sourceRoleAssignmentId: string | null,
): void {
  if (type === 'ROLE_DERIVED' && sourceRoleAssignmentId === null) {
    throw new InvariantViolation(
      'SOURCE_ROLE_REQUIRED',
      'entitlement_assignment: ROLE_DERIVED grants must reference their source role assignment',
    );
  }
  if (type !== 'ROLE_DERIVED' && sourceRoleAssignmentId !== null) {
    throw new InvariantViolation(
      'SOURCE_ROLE_FORBIDDEN',
      `entitlement_assignment: ${type} grants must not reference a role assignment`,
    );
  }
}

// ---------------------------------------------------------------------------
// Approval rules (four-eyes, no self-approval)
// ---------------------------------------------------------------------------

export function assertNoSelfApproval(approverIdentityId: string, beneficiaryIdentityId: string): void {
  if (approverIdentityId === beneficiaryIdentityId) {
    throw new InvariantViolation(
      'SELF_APPROVAL',
      'approval: the beneficiary of a request cannot approve it',
    );
  }
}

// ---------------------------------------------------------------------------
// Identity shape rules
// ---------------------------------------------------------------------------

export interface IdentityShapeInput {
  identityType: IdentityType;
  primaryEmail: string | null;
  terminationDate: Date | null;
  sponsorIdentityId: string | null;
  linkedIdentityId: string | null;
}

export function assertIdentityShape(input: IdentityShapeInput): void {
  const {identityType} = input;
  if ((identityType === 'EMPLOYEE' || identityType === 'CONTRACTOR') && input.primaryEmail === null) {
    throw new InvariantViolation('EMAIL_REQUIRED', `identity: ${identityType} requires a primary email`);
  }
  if (identityType === 'CONTRACTOR' && input.terminationDate === null) {
    throw new InvariantViolation(
      'CONTRACT_END_REQUIRED',
      'identity: CONTRACTOR requires a termination (contract end) date',
    );
  }
  if (identityType === 'SERVICE' && input.sponsorIdentityId === null) {
    throw new InvariantViolation(
      'SPONSOR_REQUIRED',
      'identity: SERVICE accounts require a sponsoring human identity',
    );
  }
  if (identityType === 'PRIVILEGED' && input.linkedIdentityId === null) {
    throw new InvariantViolation(
      'LINKED_IDENTITY_REQUIRED',
      'identity: PRIVILEGED alt-accounts must link to the owner’s standard identity',
    );
  }
}
