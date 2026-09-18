-- 0003_catalog: application registry, technical entitlements, business roles,
-- role->entitlement mappings, birthright assignment rules, and the linked
-- accounts identities hold in each application.

CREATE TABLE applications (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                         TEXT NOT NULL UNIQUE,
  description                  TEXT,
  owner_identity_id            UUID NOT NULL REFERENCES identities (id),
  security_officer_identity_id UUID REFERENCES identities (id),
  connector_type               connector_type NOT NULL DEFAULT 'MANUAL',
  fulfillment_mode             fulfillment_mode NOT NULL DEFAULT 'MANUAL',
  criticality                  criticality NOT NULL DEFAULT 'MEDIUM',
  status                       application_status NOT NULL DEFAULT 'ONBOARDING',
  -- Key Vault references / endpoint names only. Secrets are NEVER stored here.
  connector_config             JSONB NOT NULL DEFAULT '{}',
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER applications_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE applications IS 'Application registry: every system access can be requested for.';
COMMENT ON COLUMN applications.connector_config IS 'Connector settings; Key Vault references only, never secrets.';

CREATE TABLE entitlements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications (id),
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  risk_level     risk_level NOT NULL DEFAULT 'MEDIUM',
  is_privileged  BOOLEAN NOT NULL DEFAULT false,
  -- Binding to the target system (e.g. Entra group objectId / appRoleId).
  external_ref   JSONB NOT NULL DEFAULT '{}',
  status         entitlement_status NOT NULL DEFAULT 'ACTIVE',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_code_per_app UNIQUE (application_id, code)
);

CREATE INDEX entitlements_application_idx ON entitlements (application_id);

CREATE TRIGGER entitlements_updated_at
  BEFORE UPDATE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entitlements IS 'Technical entitlements: concrete permissions in target systems.';

CREATE TABLE business_roles (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                       TEXT NOT NULL UNIQUE,
  name                       TEXT NOT NULL,
  description                TEXT,
  owner_identity_id          UUID NOT NULL REFERENCES identities (id),
  risk_level                 risk_level NOT NULL DEFAULT 'MEDIUM',
  requires_security_approval BOOLEAN NOT NULL DEFAULT false,
  status                     catalog_status NOT NULL DEFAULT 'ACTIVE',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER business_roles_updated_at
  BEFORE UPDATE ON business_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE business_roles IS
  'Business roles assigned to people. Kept strictly separate from technical entitlements (mapped via role_entitlements).';

-- Mapping rows are immutable: they are added/removed (each change audited),
-- never edited, so they carry created_at only.
CREATE TABLE role_entitlements (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id              UUID NOT NULL REFERENCES business_roles (id),
  entitlement_id       UUID NOT NULL REFERENCES entitlements (id),
  added_by_identity_id UUID NOT NULL REFERENCES identities (id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT role_entitlements_unique UNIQUE (role_id, entitlement_id)
);

CREATE INDEX role_entitlements_entitlement_idx ON role_entitlements (entitlement_id);

COMMENT ON TABLE role_entitlements IS 'Business role -> technical entitlement mapping.';

CREATE TABLE role_assignment_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id          UUID NOT NULL REFERENCES business_roles (id),
  name             TEXT NOT NULL,
  -- Attribute equality filter, e.g. {"department": "Finance"}.
  attribute_filter JSONB NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 100,
  status           catalog_status NOT NULL DEFAULT 'ACTIVE',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER role_assignment_rules_updated_at
  BEFORE UPDATE ON role_assignment_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE role_assignment_rules IS 'Birthright rules: auto-assign roles from identity attributes (joiner/mover).';

CREATE TABLE identity_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id        UUID NOT NULL REFERENCES identities (id),
  application_id     UUID NOT NULL REFERENCES applications (id),
  account_identifier TEXT NOT NULL,
  account_type       account_type NOT NULL DEFAULT 'STANDARD',
  status             account_status NOT NULL DEFAULT 'ACTIVE',
  external_ref       JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT identity_accounts_unique_per_app UNIQUE (application_id, account_identifier)
);

CREATE INDEX identity_accounts_identity_idx ON identity_accounts (identity_id);

CREATE TRIGGER identity_accounts_updated_at
  BEFORE UPDATE ON identity_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE identity_accounts IS
  'Accounts an identity holds in target systems (Entra objectId, UPN, app-local usernames).';
