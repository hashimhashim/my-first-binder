-- 0001_foundation: enum types shared across the IAM schema, plus the
-- updated_at trigger function applied to every mutable table.

-- Identity repository
CREATE TYPE identity_type AS ENUM ('EMPLOYEE', 'CONTRACTOR', 'SERVICE', 'PRIVILEGED');
CREATE TYPE identity_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'LEAVING', 'TERMINATED');
CREATE TYPE identity_source AS ENUM ('MANUAL', 'HR_FEED', 'ENTRA_SYNC');
CREATE TYPE account_type AS ENUM ('STANDARD', 'PRIVILEGED', 'SERVICE');
CREATE TYPE account_status AS ENUM ('ACTIVE', 'DISABLED', 'DELETED');
CREATE TYPE lifecycle_event_type AS ENUM ('JOINER', 'MOVER', 'LEAVER', 'SUSPEND', 'REINSTATE', 'ATTRIBUTE_CHANGE');

-- Catalog
CREATE TYPE connector_type AS ENUM ('ENTRA_GRAPH', 'MANUAL');
CREATE TYPE fulfillment_mode AS ENUM ('AUTOMATED', 'MANUAL');
CREATE TYPE criticality AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE application_status AS ENUM ('ONBOARDING', 'ACTIVE', 'RETIRED');
CREATE TYPE risk_level AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE entitlement_status AS ENUM ('ACTIVE', 'DEPRECATED');
CREATE TYPE catalog_status AS ENUM ('ACTIVE', 'DISABLED');

-- Grant ledger
CREATE TYPE role_assignment_type AS ENUM ('BIRTHRIGHT', 'REQUESTED', 'TEMPORARY');
CREATE TYPE entitlement_assignment_type AS ENUM ('ROLE_DERIVED', 'EXCEPTION', 'TEMPORARY');
CREATE TYPE grant_status AS ENUM ('PENDING_PROVISIONING', 'ACTIVE', 'PENDING_REVOCATION', 'REVOKED', 'CANCELLED');
CREATE TYPE revocation_reason AS ENUM ('EXPIRY', 'LEAVER', 'MOVER', 'REVIEW', 'MANUAL', 'REQUEST');

-- Requests & approvals
CREATE TYPE request_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'PROVISIONED');
CREATE TYPE request_item_target AS ENUM ('ROLE', 'ENTITLEMENT');
CREATE TYPE request_item_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'PROVISIONED');
CREATE TYPE approval_stage_type AS ENUM ('MANAGER', 'APP_OWNER', 'SECURITY');
CREATE TYPE approval_decision AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ESCALATED');

-- Provisioning
CREATE TYPE provisioning_job_type AS ENUM ('GRANT', 'REVOKE', 'CREATE_ACCOUNT', 'DISABLE_ACCOUNT', 'ENABLE_ACCOUNT');
CREATE TYPE provisioning_job_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'MANUAL_PENDING', 'MANUAL_CONFIRMED', 'CANCELLED');

-- Reviews
CREATE TYPE review_campaign_status AS ENUM ('DRAFT', 'ACTIVE', 'CLOSING', 'CLOSED', 'CANCELLED');
CREATE TYPE reviewer_strategy AS ENUM ('MANAGER', 'APP_OWNER', 'BOTH');
CREATE TYPE review_decision AS ENUM ('PENDING', 'CERTIFIED', 'REVOKED', 'ESCALATED');

-- Policy
CREATE TYPE exception_type AS ENUM ('DIRECT_ACCESS', 'SOD_OVERRIDE', 'EXPIRY_EXTENSION');
CREATE TYPE sod_severity AS ENUM ('BLOCK', 'REQUIRE_APPROVAL', 'WARN');
CREATE TYPE sod_target_type AS ENUM ('ROLE', 'ENTITLEMENT');

-- Audit
CREATE TYPE actor_type AS ENUM ('USER', 'SYSTEM', 'CONNECTOR');

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
