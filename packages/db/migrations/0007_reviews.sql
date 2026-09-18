-- 0007_reviews: access review / recertification campaigns and their items.
-- Items snapshot the grant at campaign launch (evidence) and REVOKE decisions
-- link to the revocation job that carried them out.

CREATE TABLE access_review_campaigns (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  description            TEXT,
  -- Scope filter: applications / roles / risk levels / org units.
  scope                  JSONB NOT NULL DEFAULT '{}',
  reviewer_strategy      reviewer_strategy NOT NULL,
  starts_at              TIMESTAMPTZ,
  due_at                 TIMESTAMPTZ,
  status                 review_campaign_status NOT NULL DEFAULT 'DRAFT',
  auto_revoke_on_close   BOOLEAN NOT NULL DEFAULT false,
  created_by_identity_id UUID NOT NULL REFERENCES identities (id),
  closed_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT access_review_campaigns_dates_ordered
    CHECK (starts_at IS NULL OR due_at IS NULL OR due_at > starts_at)
);

CREATE TRIGGER access_review_campaigns_updated_at
  BEFORE UPDATE ON access_review_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE access_review_campaigns IS 'Recertification campaigns; exports serve as compliance evidence.';

CREATE TABLE access_review_items (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id               UUID NOT NULL REFERENCES access_review_campaigns (id),
  entitlement_assignment_id UUID REFERENCES entitlement_assignments (id),
  role_assignment_id        UUID REFERENCES role_assignments (id),
  reviewer_identity_id      UUID NOT NULL REFERENCES identities (id),
  -- Grant state captured at campaign launch: the reviewed evidence.
  snapshot                  JSONB NOT NULL,
  decision                  review_decision NOT NULL DEFAULT 'PENDING',
  decided_by_identity_id    UUID REFERENCES identities (id),
  decided_at                TIMESTAMPTZ,
  comment                   TEXT,
  revocation_job_id         UUID REFERENCES provisioning_jobs (id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT access_review_items_exactly_one_grant CHECK (
    num_nonnulls(entitlement_assignment_id, role_assignment_id) = 1
  ),
  CONSTRAINT access_review_items_decided_fields CHECK (
    decision = 'PENDING' OR (decided_at IS NOT NULL AND decided_by_identity_id IS NOT NULL)
  )
);

-- A reviewer sees each grant at most once per campaign.
CREATE UNIQUE INDEX access_review_items_unique_ea
  ON access_review_items (campaign_id, reviewer_identity_id, entitlement_assignment_id)
  WHERE entitlement_assignment_id IS NOT NULL;
CREATE UNIQUE INDEX access_review_items_unique_ra
  ON access_review_items (campaign_id, reviewer_identity_id, role_assignment_id)
  WHERE role_assignment_id IS NOT NULL;

CREATE INDEX access_review_items_reviewer_pending_idx
  ON access_review_items (reviewer_identity_id) WHERE decision = 'PENDING';

CREATE TRIGGER access_review_items_updated_at
  BEFORE UPDATE ON access_review_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE access_review_items IS 'Individual grant reviews within a campaign.';
