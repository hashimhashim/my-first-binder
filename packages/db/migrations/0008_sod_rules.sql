-- 0008_sod_rules: segregation-of-duties rule scaffold. Rules pair two
-- targets (roles or entitlements) that conflict; the request service
-- evaluates them at submission time from day one (the rule set may be empty).

CREATE TABLE sod_rules (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL UNIQUE,
  description            TEXT,
  first_target_type      sod_target_type NOT NULL,
  first_role_id          UUID REFERENCES business_roles (id),
  first_entitlement_id   UUID REFERENCES entitlements (id),
  second_target_type     sod_target_type NOT NULL,
  second_role_id         UUID REFERENCES business_roles (id),
  second_entitlement_id  UUID REFERENCES entitlements (id),
  severity               sod_severity NOT NULL,
  status                 catalog_status NOT NULL DEFAULT 'ACTIVE',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sod_rules_first_target_matches CHECK (
    (first_target_type = 'ROLE' AND first_role_id IS NOT NULL AND first_entitlement_id IS NULL)
    OR
    (first_target_type = 'ENTITLEMENT' AND first_entitlement_id IS NOT NULL AND first_role_id IS NULL)
  ),
  CONSTRAINT sod_rules_second_target_matches CHECK (
    (second_target_type = 'ROLE' AND second_role_id IS NOT NULL AND second_entitlement_id IS NULL)
    OR
    (second_target_type = 'ENTITLEMENT' AND second_entitlement_id IS NOT NULL AND second_role_id IS NULL)
  )
);

CREATE TRIGGER sod_rules_updated_at
  BEFORE UPDATE ON sod_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE sod_rules IS 'Segregation-of-duties conflict pairs, evaluated at request submission.';
