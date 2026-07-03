-- 0005_grants: the grant ledger — the source of truth for who holds what.
-- role_assignments: identity <-> business role.
-- entitlement_assignments: identity <-> technical entitlement, always
--   traceable to a source (role expansion, approved request, or exception).
-- policy_exceptions: governance record for direct exception access.
--
-- Hard rules enforced here (working rule 8):
--   * TEMPORARY role assignments must have expires_at.
--   * TEMPORARY and EXCEPTION entitlement assignments must have expires_at.
--   * At most one live grant per (identity, role/entitlement).

CREATE TABLE role_assignments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id            UUID NOT NULL REFERENCES identities (id),
  role_id                UUID NOT NULL REFERENCES business_roles (id),
  assignment_type        role_assignment_type NOT NULL,
  granted_via_request_id UUID REFERENCES access_requests (id),
  granted_by_identity_id UUID REFERENCES identities (id),
  starts_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ,
  status                 grant_status NOT NULL DEFAULT 'PENDING_PROVISIONING',
  revoked_reason         revocation_reason,
  revoked_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT role_assignments_temporary_requires_expiry
    CHECK (assignment_type <> 'TEMPORARY' OR expires_at IS NOT NULL),
  CONSTRAINT role_assignments_expiry_after_start
    CHECK (expires_at IS NULL OR expires_at > starts_at),
  CONSTRAINT role_assignments_revoked_fields
    CHECK (status <> 'REVOKED' OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL))
);

-- One live grant per identity+role; a new grant is allowed once the old one
-- is REVOKED or CANCELLED.
CREATE UNIQUE INDEX role_assignments_one_live
  ON role_assignments (identity_id, role_id)
  WHERE status IN ('PENDING_PROVISIONING', 'ACTIVE', 'PENDING_REVOCATION');

CREATE INDEX role_assignments_identity_idx ON role_assignments (identity_id);
CREATE INDEX role_assignments_expiry_sweep_idx
  ON role_assignments (expires_at)
  WHERE expires_at IS NOT NULL AND status IN ('PENDING_PROVISIONING', 'ACTIVE');

CREATE TRIGGER role_assignments_updated_at
  BEFORE UPDATE ON role_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE role_assignments IS 'Business role grants held by identities.';

CREATE TABLE entitlement_assignments (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id               UUID NOT NULL REFERENCES identities (id),
  entitlement_id            UUID NOT NULL REFERENCES entitlements (id),
  assignment_type           entitlement_assignment_type NOT NULL,
  source_role_assignment_id UUID REFERENCES role_assignments (id),
  granted_via_request_id    UUID REFERENCES access_requests (id),
  granted_by_identity_id    UUID REFERENCES identities (id),
  starts_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                TIMESTAMPTZ,
  status                    grant_status NOT NULL DEFAULT 'PENDING_PROVISIONING',
  revoked_reason            revocation_reason,
  revoked_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Temporary and exception access ALWAYS expires.
  CONSTRAINT entitlement_assignments_expiry_required
    CHECK (assignment_type NOT IN ('EXCEPTION', 'TEMPORARY') OR expires_at IS NOT NULL),
  -- Role-derived grants trace to their role assignment; others must not.
  CONSTRAINT entitlement_assignments_source_matches_type
    CHECK ((assignment_type = 'ROLE_DERIVED') = (source_role_assignment_id IS NOT NULL)),
  CONSTRAINT entitlement_assignments_expiry_after_start
    CHECK (expires_at IS NULL OR expires_at > starts_at),
  CONSTRAINT entitlement_assignments_revoked_fields
    CHECK (status <> 'REVOKED' OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL))
);

CREATE UNIQUE INDEX entitlement_assignments_one_live
  ON entitlement_assignments (identity_id, entitlement_id)
  WHERE status IN ('PENDING_PROVISIONING', 'ACTIVE', 'PENDING_REVOCATION');

CREATE INDEX entitlement_assignments_identity_idx ON entitlement_assignments (identity_id);
CREATE INDEX entitlement_assignments_entitlement_idx ON entitlement_assignments (entitlement_id);
CREATE INDEX entitlement_assignments_source_role_idx
  ON entitlement_assignments (source_role_assignment_id)
  WHERE source_role_assignment_id IS NOT NULL;
CREATE INDEX entitlement_assignments_expiry_sweep_idx
  ON entitlement_assignments (expires_at)
  WHERE expires_at IS NOT NULL AND status IN ('PENDING_PROVISIONING', 'ACTIVE');

CREATE TRIGGER entitlement_assignments_updated_at
  BEFORE UPDATE ON entitlement_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entitlement_assignments IS
  'The grant ledger: every technical entitlement an identity holds, its origin, and its expiry.';

CREATE TABLE policy_exceptions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_assignment_id UUID NOT NULL UNIQUE REFERENCES entitlement_assignments (id),
  exception_type            exception_type NOT NULL,
  justification             TEXT NOT NULL,
  approved_by_identity_id   UUID NOT NULL REFERENCES identities (id),
  -- Exceptions always expire.
  expires_at                TIMESTAMPTZ NOT NULL,
  review_before             DATE,
  revoked_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT policy_exceptions_justification_nonempty CHECK (char_length(btrim(justification)) > 0)
);

CREATE TRIGGER policy_exceptions_updated_at
  BEFORE UPDATE ON policy_exceptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE policy_exceptions IS
  'Governance record for direct exception access (security-approved, always expiring).';
