-- 0004_requests: self-service access requests, request line items, and the
-- multi-stage approval chain. Approval chains are computed at submission
-- (manager -> app owner -> security) and stored as rows for full evidence.

CREATE TABLE access_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_identity_id   UUID NOT NULL REFERENCES identities (id),
  -- Who receives the access; equals requester unless on-behalf-of.
  beneficiary_identity_id UUID NOT NULL REFERENCES identities (id),
  justification           TEXT NOT NULL,
  status                  request_status NOT NULL DEFAULT 'DRAFT',
  -- SoD conflicts detected at submission, shown to approvers.
  sod_flags               JSONB NOT NULL DEFAULT '[]',
  submitted_at            TIMESTAMPTZ,
  decided_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT access_requests_justification_nonempty CHECK (char_length(btrim(justification)) > 0)
);

CREATE INDEX access_requests_beneficiary_idx ON access_requests (beneficiary_identity_id);
CREATE INDEX access_requests_status_idx ON access_requests (status);

CREATE TRIGGER access_requests_updated_at
  BEFORE UPDATE ON access_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE access_requests IS 'Self-service access requests (self or on-behalf-of).';

CREATE TABLE access_request_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           UUID NOT NULL REFERENCES access_requests (id),
  target_type          request_item_target NOT NULL,
  role_id              UUID REFERENCES business_roles (id),
  entitlement_id       UUID REFERENCES entitlements (id),
  -- If set, the resulting grant is TEMPORARY with this expiry.
  requested_expires_at TIMESTAMPTZ,
  status               request_item_status NOT NULL DEFAULT 'PENDING',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The target column must match target_type, and exactly one is set.
  CONSTRAINT access_request_items_target_matches CHECK (
    (target_type = 'ROLE' AND role_id IS NOT NULL AND entitlement_id IS NULL)
    OR
    (target_type = 'ENTITLEMENT' AND entitlement_id IS NOT NULL AND role_id IS NULL)
  )
);

CREATE INDEX access_request_items_request_idx ON access_request_items (request_id);

CREATE TRIGGER access_request_items_updated_at
  BEFORE UPDATE ON access_request_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE access_request_items IS
  'Line items of a request: a business role, or a technical entitlement (direct exception path).';

CREATE TABLE approvals (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id               UUID NOT NULL REFERENCES access_requests (id),
  stage_order              INTEGER NOT NULL,
  stage_type               approval_stage_type NOT NULL,
  approver_identity_id     UUID NOT NULL REFERENCES identities (id),
  delegated_to_identity_id UUID REFERENCES identities (id),
  decision                 approval_decision NOT NULL DEFAULT 'PENDING',
  comment                  TEXT,
  decided_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT approvals_stage_order_positive CHECK (stage_order > 0),
  CONSTRAINT approvals_decided_has_timestamp
    CHECK (decision IN ('PENDING', 'ESCALATED') OR decided_at IS NOT NULL),
  CONSTRAINT approvals_unique_stage_approver UNIQUE (request_id, stage_order, approver_identity_id)
);

CREATE INDEX approvals_approver_pending_idx
  ON approvals (approver_identity_id) WHERE decision = 'PENDING';

CREATE TRIGGER approvals_updated_at
  BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE approvals IS 'Per-stage approval records for an access request.';

-- Four-eyes at the database level: the beneficiary of a request can never
-- hold or decide an approval on that request, and neither can a delegate
-- who is the beneficiary. (Also enforced in the domain layer.)
CREATE FUNCTION approvals_forbid_self_approval() RETURNS trigger AS $$
DECLARE
  v_beneficiary UUID;
BEGIN
  SELECT beneficiary_identity_id INTO v_beneficiary
    FROM access_requests WHERE id = NEW.request_id;
  IF NEW.approver_identity_id = v_beneficiary
     OR NEW.delegated_to_identity_id = v_beneficiary THEN
    RAISE EXCEPTION 'self-approval forbidden: identity % is the beneficiary of request %',
      v_beneficiary, NEW.request_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER approvals_no_self_approval
  BEFORE INSERT OR UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_forbid_self_approval();
