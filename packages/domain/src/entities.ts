/**
 * Domain entity types. One interface per table in @iam/db.
 *
 * Conventions:
 *  - `id` is a UUID string.
 *  - Timestamps are `Date` in the domain layer (TIMESTAMPTZ in Postgres).
 *  - Nullable columns are `| null`, never optional properties, so a missing
 *    field is a compile error rather than a silent undefined.
 *  - Every mutable table carries the audit fields `createdAt` / `updatedAt`.
 */

import type {
  AccountStatus,
  AccountType,
  ActorType,
  ApplicationStatus,
  ApprovalDecision,
  ApprovalStageType,
  CatalogStatus,
  ConnectorType,
  Criticality,
  EntitlementAssignmentType,
  EntitlementStatus,
  ExceptionType,
  FulfillmentMode,
  GrantStatus,
  IdentitySource,
  IdentityStatus,
  IdentityType,
  LifecycleEventType,
  ProvisioningJobStatus,
  ProvisioningJobType,
  RequestItemStatus,
  RequestItemTarget,
  RequestStatus,
  ReviewCampaignStatus,
  ReviewDecision,
  ReviewerStrategy,
  RevocationReason,
  RiskLevel,
  RoleAssignmentType,
  SodSeverity,
  SodTargetType,
} from './enums.js';

export type UUID = string;

export interface AuditedRow {
  id: UUID;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Identity repository
// ---------------------------------------------------------------------------

export interface Identity extends AuditedRow {
  identityType: IdentityType;
  employeeNumber: string | null;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  /** Required for EMPLOYEE and CONTRACTOR; optional for SERVICE/PRIVILEGED. */
  primaryEmail: string | null;
  managerId: UUID | null;
  department: string | null;
  businessUnit: string | null;
  location: string | null;
  jobTitle: string | null;
  status: IdentityStatus;
  startDate: Date | null;
  /** Required for CONTRACTOR (hard end date). Drives the leaver workflow. */
  terminationDate: Date | null;
  /** Owning human identity; required for SERVICE identities. */
  sponsorIdentityId: UUID | null;
  /** For PRIVILEGED alt-accounts: the standard identity of the same person. Required. */
  linkedIdentityId: UUID | null;
  source: IdentitySource;
}

export interface IdentityAccount extends AuditedRow {
  identityId: UUID;
  applicationId: UUID;
  /** UPN / objectId / sAMAccountName / app-local username in the target system. */
  accountIdentifier: string;
  accountType: AccountType;
  status: AccountStatus;
  externalRef: Record<string, unknown>;
}

export interface LifecycleEvent extends AuditedRow {
  identityId: UUID;
  eventType: LifecycleEventType;
  /** Before/after attribute payload for MOVER / ATTRIBUTE_CHANGE events. */
  payload: Record<string, unknown>;
  triggeredByIdentityId: UUID | null;
  actorType: ActorType;
  occurredAt: Date;
  processedAt: Date | null;
  /** Summary of downstream actions taken (roles added/removed, jobs queued). */
  resultingActions: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Application & entitlement catalog
// ---------------------------------------------------------------------------

export interface Application extends AuditedRow {
  name: string;
  description: string | null;
  ownerIdentityId: UUID;
  securityOfficerIdentityId: UUID | null;
  connectorType: ConnectorType;
  fulfillmentMode: FulfillmentMode;
  criticality: Criticality;
  status: ApplicationStatus;
  /** Connector settings. MUST hold Key Vault references only — never secrets. */
  connectorConfig: Record<string, unknown>;
}

/** Technical entitlement: a concrete permission in a target system. */
export interface Entitlement extends AuditedRow {
  applicationId: UUID;
  code: string;
  name: string;
  description: string | null;
  riskLevel: RiskLevel;
  isPrivileged: boolean;
  /** Binding to the target system, e.g. Entra group objectId / appRoleId. */
  externalRef: Record<string, unknown>;
  status: EntitlementStatus;
}

/** Business role: a governed bundle of technical entitlements assigned to people. */
export interface BusinessRole extends AuditedRow {
  code: string;
  name: string;
  description: string | null;
  ownerIdentityId: UUID;
  riskLevel: RiskLevel;
  requiresSecurityApproval: boolean;
  status: CatalogStatus;
}

/** Mapping row: business role -> technical entitlement. Immutable; replaced, not edited. */
export interface RoleEntitlement {
  id: UUID;
  roleId: UUID;
  entitlementId: UUID;
  addedByIdentityId: UUID;
  createdAt: Date;
}

/** Birthright rule: auto-assign a role when identity attributes match the filter. */
export interface RoleAssignmentRule extends AuditedRow {
  roleId: UUID;
  name: string;
  /** Attribute equality filter, e.g. {"department": "Finance", "identityType": "EMPLOYEE"}. */
  attributeFilter: Record<string, string>;
  priority: number;
  status: CatalogStatus;
}

// ---------------------------------------------------------------------------
// Grant ledger
// ---------------------------------------------------------------------------

export interface RoleAssignment extends AuditedRow {
  identityId: UUID;
  roleId: UUID;
  assignmentType: RoleAssignmentType;
  grantedViaRequestId: UUID | null;
  grantedByIdentityId: UUID | null;
  startsAt: Date;
  /** REQUIRED when assignmentType = TEMPORARY (enforced by DB CHECK). */
  expiresAt: Date | null;
  status: GrantStatus;
  revokedReason: RevocationReason | null;
  revokedAt: Date | null;
}

export interface EntitlementAssignment extends AuditedRow {
  identityId: UUID;
  entitlementId: UUID;
  assignmentType: EntitlementAssignmentType;
  /** REQUIRED when assignmentType = ROLE_DERIVED (and forbidden otherwise). */
  sourceRoleAssignmentId: UUID | null;
  grantedViaRequestId: UUID | null;
  grantedByIdentityId: UUID | null;
  startsAt: Date;
  /** REQUIRED when assignmentType is EXCEPTION or TEMPORARY (DB CHECK). */
  expiresAt: Date | null;
  status: GrantStatus;
  revokedReason: RevocationReason | null;
  revokedAt: Date | null;
}

/** Governance record for a direct exception grant. One per exception assignment. */
export interface PolicyException extends AuditedRow {
  entitlementAssignmentId: UUID;
  exceptionType: ExceptionType;
  justification: string;
  approvedByIdentityId: UUID;
  /** Exceptions always expire. */
  expiresAt: Date;
  reviewBefore: Date | null;
  revokedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Access requests & approvals
// ---------------------------------------------------------------------------

export interface AccessRequest extends AuditedRow {
  requesterIdentityId: UUID;
  /** Who receives the access (equals requester unless on-behalf-of). */
  beneficiaryIdentityId: UUID;
  justification: string;
  status: RequestStatus;
  /** SoD conflicts detected at submission, for approver visibility. */
  sodFlags: unknown[];
  submittedAt: Date | null;
  decidedAt: Date | null;
}

export interface AccessRequestItem extends AuditedRow {
  requestId: UUID;
  targetType: RequestItemTarget;
  roleId: UUID | null;
  entitlementId: UUID | null;
  /** Requested expiry; makes the resulting grant TEMPORARY. */
  requestedExpiresAt: Date | null;
  status: RequestItemStatus;
}

export interface Approval extends AuditedRow {
  requestId: UUID;
  stageOrder: number;
  stageType: ApprovalStageType;
  approverIdentityId: UUID;
  delegatedToIdentityId: UUID | null;
  decision: ApprovalDecision;
  comment: string | null;
  decidedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export interface ProvisioningJob extends AuditedRow {
  jobType: ProvisioningJobType;
  applicationId: UUID;
  /** Exactly one of the three targets is set (DB CHECK). */
  entitlementAssignmentId: UUID | null;
  roleAssignmentId: UUID | null;
  identityAccountId: UUID | null;
  connectorType: ConnectorType;
  /** Unique key making retries and duplicate dispatch safe. */
  idempotencyKey: string;
  /** Connector input. Redacted — never contains secrets. */
  payload: Record<string, unknown>;
  status: ProvisioningJobStatus;
  attemptCount: number;
  lastError: string | null;
  scheduledFor: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  manualConfirmedByIdentityId: UUID | null;
  manualConfirmedAt: Date | null;
  correlationId: UUID | null;
}

// ---------------------------------------------------------------------------
// Access reviews / recertification
// ---------------------------------------------------------------------------

export interface AccessReviewCampaign extends AuditedRow {
  name: string;
  description: string | null;
  /** Scope filter: applications / roles / risk levels / org units. */
  scope: Record<string, unknown>;
  reviewerStrategy: ReviewerStrategy;
  startsAt: Date | null;
  dueAt: Date | null;
  status: ReviewCampaignStatus;
  autoRevokeOnClose: boolean;
  createdByIdentityId: UUID;
  closedAt: Date | null;
}

export interface AccessReviewItem extends AuditedRow {
  campaignId: UUID;
  /** Exactly one of the two grant references is set (DB CHECK). */
  entitlementAssignmentId: UUID | null;
  roleAssignmentId: UUID | null;
  reviewerIdentityId: UUID;
  /** Grant state captured at campaign launch — the evidence snapshot. */
  snapshot: Record<string, unknown>;
  decision: ReviewDecision;
  decidedByIdentityId: UUID | null;
  decidedAt: Date | null;
  comment: string | null;
  revocationJobId: UUID | null;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface SodRule extends AuditedRow {
  name: string;
  description: string | null;
  firstTargetType: SodTargetType;
  firstRoleId: UUID | null;
  firstEntitlementId: UUID | null;
  secondTargetType: SodTargetType;
  secondRoleId: UUID | null;
  secondEntitlementId: UUID | null;
  severity: SodSeverity;
  status: CatalogStatus;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Append-only. No updatedAt: rows are never mutated (enforced by DB trigger). */
export interface AuditEvent {
  id: UUID;
  occurredAt: Date;
  actorIdentityId: UUID | null;
  actorType: ActorType;
  /** Dotted action name from AUDIT_ACTIONS, e.g. "access_request.approved". */
  action: string;
  entityType: string;
  entityId: UUID | null;
  correlationId: UUID | null;
  /** IP / user agent / route. Never tokens or credentials. */
  requestContext: Record<string, unknown>;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  createdAt: Date;
}
