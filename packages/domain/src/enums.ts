/**
 * Canonical enumerations for the IAM domain.
 *
 * These mirror the Postgres ENUM types created in @iam/db migrations
 * (0001_foundation.sql). If a value is added here it MUST be added to the
 * database enum in a new migration, and vice versa.
 */

export const IDENTITY_TYPES = ['EMPLOYEE', 'CONTRACTOR', 'SERVICE', 'PRIVILEGED'] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

export const IDENTITY_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'LEAVING', 'TERMINATED'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export const IDENTITY_SOURCES = ['MANUAL', 'HR_FEED', 'ENTRA_SYNC'] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export const ACCOUNT_TYPES = ['STANDARD', 'PRIVILEGED', 'SERVICE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_STATUSES = ['ACTIVE', 'DISABLED', 'DELETED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const CONNECTOR_TYPES = ['ENTRA_GRAPH', 'MANUAL'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const FULFILLMENT_MODES = ['AUTOMATED', 'MANUAL'] as const;
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

export const CRITICALITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Criticality = (typeof CRITICALITY_LEVELS)[number];

export const APPLICATION_STATUSES = ['ONBOARDING', 'ACTIVE', 'RETIRED'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const ENTITLEMENT_STATUSES = ['ACTIVE', 'DEPRECATED'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/** Status for catalog config objects (business roles, assignment rules, SoD rules). */
export const CATALOG_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export const ROLE_ASSIGNMENT_TYPES = ['BIRTHRIGHT', 'REQUESTED', 'TEMPORARY'] as const;
export type RoleAssignmentType = (typeof ROLE_ASSIGNMENT_TYPES)[number];

export const ENTITLEMENT_ASSIGNMENT_TYPES = ['ROLE_DERIVED', 'EXCEPTION', 'TEMPORARY'] as const;
export type EntitlementAssignmentType = (typeof ENTITLEMENT_ASSIGNMENT_TYPES)[number];

/** Shared lifecycle for both role_assignments and entitlement_assignments (the grant ledger). */
export const GRANT_STATUSES = [
  'PENDING_PROVISIONING',
  'ACTIVE',
  'PENDING_REVOCATION',
  'REVOKED',
  'CANCELLED',
] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const REVOCATION_REASONS = ['EXPIRY', 'LEAVER', 'MOVER', 'REVIEW', 'MANUAL', 'REQUEST'] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

export const REQUEST_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'PROVISIONED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_ITEM_TARGETS = ['ROLE', 'ENTITLEMENT'] as const;
export type RequestItemTarget = (typeof REQUEST_ITEM_TARGETS)[number];

export const REQUEST_ITEM_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'PROVISIONED'] as const;
export type RequestItemStatus = (typeof REQUEST_ITEM_STATUSES)[number];

export const APPROVAL_STAGE_TYPES = ['MANAGER', 'APP_OWNER', 'SECURITY'] as const;
export type ApprovalStageType = (typeof APPROVAL_STAGE_TYPES)[number];

export const APPROVAL_DECISIONS = ['PENDING', 'APPROVED', 'REJECTED', 'ESCALATED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const PROVISIONING_JOB_TYPES = [
  'GRANT',
  'REVOKE',
  'CREATE_ACCOUNT',
  'DISABLE_ACCOUNT',
  'ENABLE_ACCOUNT',
] as const;
export type ProvisioningJobType = (typeof PROVISIONING_JOB_TYPES)[number];

export const PROVISIONING_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'MANUAL_PENDING',
  'MANUAL_CONFIRMED',
  'CANCELLED',
] as const;
export type ProvisioningJobStatus = (typeof PROVISIONING_JOB_STATUSES)[number];

export const REVIEW_CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSING', 'CLOSED', 'CANCELLED'] as const;
export type ReviewCampaignStatus = (typeof REVIEW_CAMPAIGN_STATUSES)[number];

export const REVIEWER_STRATEGIES = ['MANAGER', 'APP_OWNER', 'BOTH'] as const;
export type ReviewerStrategy = (typeof REVIEWER_STRATEGIES)[number];

export const REVIEW_DECISIONS = ['PENDING', 'CERTIFIED', 'REVOKED', 'ESCALATED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const EXCEPTION_TYPES = ['DIRECT_ACCESS', 'SOD_OVERRIDE', 'EXPIRY_EXTENSION'] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export const SOD_SEVERITIES = ['BLOCK', 'REQUIRE_APPROVAL', 'WARN'] as const;
export type SodSeverity = (typeof SOD_SEVERITIES)[number];

export const SOD_TARGET_TYPES = ['ROLE', 'ENTITLEMENT'] as const;
export type SodTargetType = (typeof SOD_TARGET_TYPES)[number];

export const LIFECYCLE_EVENT_TYPES = [
  'JOINER',
  'MOVER',
  'LEAVER',
  'SUSPEND',
  'REINSTATE',
  'ATTRIBUTE_CHANGE',
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'CONNECTOR'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
