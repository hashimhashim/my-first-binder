-- 0002_identities: the identity repository (system of record for people,
-- contractors, service accounts and privileged alt-accounts) and the
-- lifecycle event journal that drives Joiner / Mover / Leaver processing.

CREATE TABLE identities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_type       identity_type NOT NULL,
  employee_number     TEXT,
  display_name        TEXT NOT NULL,
  given_name          TEXT,
  family_name         TEXT,
  primary_email       TEXT,
  manager_id          UUID REFERENCES identities (id),
  department          TEXT,
  business_unit       TEXT,
  location            TEXT,
  job_title           TEXT,
  status              identity_status NOT NULL DEFAULT 'PENDING',
  start_date          DATE,
  termination_date    DATE,
  sponsor_identity_id UUID REFERENCES identities (id),
  linked_identity_id  UUID REFERENCES identities (id),
  source              identity_source NOT NULL DEFAULT 'MANUAL',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Human identities must be reachable.
  CONSTRAINT identities_human_requires_email
    CHECK (identity_type NOT IN ('EMPLOYEE', 'CONTRACTOR') OR primary_email IS NOT NULL),
  -- Contractors always have a hard contract end date (drives leaver workflow).
  CONSTRAINT identities_contractor_requires_end
    CHECK (identity_type <> 'CONTRACTOR' OR termination_date IS NOT NULL),
  -- Service accounts always have an accountable human sponsor.
  CONSTRAINT identities_service_requires_sponsor
    CHECK (identity_type <> 'SERVICE' OR sponsor_identity_id IS NOT NULL),
  -- Privileged alt-accounts always link back to the person's standard identity.
  CONSTRAINT identities_privileged_requires_link
    CHECK (identity_type <> 'PRIVILEGED' OR linked_identity_id IS NOT NULL),
  CONSTRAINT identities_no_self_manager
    CHECK (manager_id IS NULL OR manager_id <> id),
  CONSTRAINT identities_no_self_link
    CHECK (linked_identity_id IS NULL OR linked_identity_id <> id),
  CONSTRAINT identities_no_self_sponsor
    CHECK (sponsor_identity_id IS NULL OR sponsor_identity_id <> id),
  CONSTRAINT identities_dates_ordered
    CHECK (start_date IS NULL OR termination_date IS NULL OR termination_date >= start_date)
);

CREATE UNIQUE INDEX identities_employee_number_key
  ON identities (employee_number) WHERE employee_number IS NOT NULL;
CREATE UNIQUE INDEX identities_primary_email_key
  ON identities (lower(primary_email)) WHERE primary_email IS NOT NULL;
CREATE INDEX identities_manager_idx ON identities (manager_id);
CREATE INDEX identities_status_idx ON identities (status);
CREATE INDEX identities_type_idx ON identities (identity_type);

CREATE TRIGGER identities_updated_at
  BEFORE UPDATE ON identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE identities IS
  'Identity repository: employees, contractors, service accounts, privileged alt-accounts. Source of truth for JML.';

CREATE TABLE lifecycle_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id              UUID NOT NULL REFERENCES identities (id),
  event_type               lifecycle_event_type NOT NULL,
  payload                  JSONB NOT NULL DEFAULT '{}',
  triggered_by_identity_id UUID REFERENCES identities (id),
  actor_type               actor_type NOT NULL DEFAULT 'USER',
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at             TIMESTAMPTZ,
  resulting_actions        JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX lifecycle_events_identity_idx ON lifecycle_events (identity_id, occurred_at);
CREATE INDEX lifecycle_events_unprocessed_idx ON lifecycle_events (occurred_at) WHERE processed_at IS NULL;

CREATE TRIGGER lifecycle_events_updated_at
  BEFORE UPDATE ON lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE lifecycle_events IS
  'Journal of JML events (joiner/mover/leaver/suspend/reinstate). Workers consume unprocessed rows.';
