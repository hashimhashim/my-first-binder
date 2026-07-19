-- 0009_audit: append-only audit event log. Every sensitive action writes a
-- row here IN THE SAME TRANSACTION as the state change (working rule 7).
-- UPDATE and DELETE are blocked by trigger so history cannot be rewritten
-- even by application bugs; retention/archival is handled by ops tooling
-- with a dedicated role, never by the application.

CREATE TABLE audit_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_identity_id  UUID REFERENCES identities (id),
  actor_type         actor_type NOT NULL,
  -- Dotted action name from the @iam/domain AUDIT_ACTIONS catalog.
  action             TEXT NOT NULL,
  entity_type        TEXT NOT NULL,
  entity_id          UUID,
  correlation_id     UUID,
  -- IP / user agent / route. Never tokens or credentials.
  request_context    JSONB NOT NULL DEFAULT '{}',
  before_state       JSONB,
  after_state        JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT audit_events_action_format CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT audit_events_user_has_actor
    CHECK (actor_type <> 'USER' OR actor_identity_id IS NOT NULL)
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, occurred_at);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_identity_id, occurred_at);
CREATE INDEX audit_events_action_idx ON audit_events (action, occurred_at);
CREATE INDEX audit_events_correlation_idx
  ON audit_events (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE FUNCTION audit_events_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();

COMMENT ON TABLE audit_events IS
  'Append-only audit trail: request/approval/grant/revoke/review evidence. Mutations blocked by trigger.';
