-- 0006_provisioning: provisioning job queue. Each approved grant / revocation
-- fans out into jobs executed by connectors (Entra Graph, ...) or routed to
-- the manual fulfillment queue. Jobs are idempotent via idempotency_key.

CREATE TABLE provisioning_jobs (
  id                               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type                         provisioning_job_type NOT NULL,
  application_id                   UUID NOT NULL REFERENCES applications (id),
  entitlement_assignment_id        UUID REFERENCES entitlement_assignments (id),
  role_assignment_id               UUID REFERENCES role_assignments (id),
  identity_account_id              UUID REFERENCES identity_accounts (id),
  connector_type                   connector_type NOT NULL,
  idempotency_key                  TEXT NOT NULL UNIQUE,
  -- Connector input; passes the redaction filter, never contains secrets.
  payload                          JSONB NOT NULL DEFAULT '{}',
  status                           provisioning_job_status NOT NULL DEFAULT 'QUEUED',
  attempt_count                    INTEGER NOT NULL DEFAULT 0,
  last_error                       TEXT,
  scheduled_for                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at                       TIMESTAMPTZ,
  completed_at                     TIMESTAMPTZ,
  manual_confirmed_by_identity_id  UUID REFERENCES identities (id),
  manual_confirmed_at              TIMESTAMPTZ,
  correlation_id                   UUID,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A job targets exactly one thing: a grant, a role grant, or an account.
  CONSTRAINT provisioning_jobs_exactly_one_target CHECK (
    num_nonnulls(entitlement_assignment_id, role_assignment_id, identity_account_id) = 1
  ),
  -- Manual confirmations are attributed and timestamped together.
  CONSTRAINT provisioning_jobs_manual_confirmation_complete CHECK (
    (manual_confirmed_at IS NULL) = (manual_confirmed_by_identity_id IS NULL)
  ),
  CONSTRAINT provisioning_jobs_confirmed_status CHECK (
    manual_confirmed_at IS NULL OR status IN ('MANUAL_CONFIRMED', 'CANCELLED')
  )
);

CREATE INDEX provisioning_jobs_due_idx
  ON provisioning_jobs (scheduled_for) WHERE status IN ('QUEUED', 'FAILED');
CREATE INDEX provisioning_jobs_manual_queue_idx
  ON provisioning_jobs (application_id) WHERE status = 'MANUAL_PENDING';
CREATE INDEX provisioning_jobs_assignment_idx
  ON provisioning_jobs (entitlement_assignment_id) WHERE entitlement_assignment_id IS NOT NULL;

CREATE TRIGGER provisioning_jobs_updated_at
  BEFORE UPDATE ON provisioning_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE provisioning_jobs IS
  'Provisioning orchestration queue: idempotent grant/revoke/account jobs with manual fulfillment fallback.';
