# @iam/db — IAM schema & migrations

Plain-SQL migrations (source of truth for the schema) plus a transactional,
checksummed migration runner. The typed domain model lives in `@iam/domain`;
the two are kept in lockstep (every DB enum mirrors a domain enum).

## Usage

```bash
# apply pending migrations
DATABASE_URL=postgres://user:pass@host:5432/iam npm run migrate --workspace @iam/db

# run schema integration tests (needs a Postgres admin connection)
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test --workspace @iam/db
```

Rules:
- Never edit an applied migration — the runner rejects checksum drift. Write a new file.
- Files apply in filename order: `NNNN_description.sql`.
- Each migration runs in its own transaction; an advisory lock serializes concurrent runners.

## Entity-relationship overview

```mermaid
erDiagram
    identities ||--o{ identity_accounts : holds
    identities ||--o{ lifecycle_events : "JML journal"
    identities ||--o{ role_assignments : "has role"
    identities ||--o{ entitlement_assignments : "has grant"
    applications ||--o{ identity_accounts : "account in"
    applications ||--o{ entitlements : exposes
    business_roles ||--o{ role_entitlements : bundles
    entitlements ||--o{ role_entitlements : "mapped by"
    business_roles ||--o{ role_assignment_rules : "birthright"
    business_roles ||--o{ role_assignments : granted
    entitlements ||--o{ entitlement_assignments : granted
    role_assignments ||--o{ entitlement_assignments : "expands to"
    access_requests ||--o{ access_request_items : contains
    access_requests ||--o{ approvals : "decided by"
    access_requests ||--o{ role_assignments : produces
    access_requests ||--o{ entitlement_assignments : produces
    entitlement_assignments ||--o| policy_exceptions : "justified by"
    entitlement_assignments ||--o{ provisioning_jobs : "fulfilled by"
    role_assignments ||--o{ provisioning_jobs : "fulfilled by"
    identity_accounts ||--o{ provisioning_jobs : "acted on by"
    access_review_campaigns ||--o{ access_review_items : contains
    entitlement_assignments ||--o{ access_review_items : reviews
    role_assignments ||--o{ access_review_items : reviews
    provisioning_jobs ||--o{ access_review_items : "revocation evidence"
    identities ||--o{ audit_events : "acted"
```

## Schema-enforced IAM invariants

These hold no matter what application code does:

| Invariant | Mechanism |
|---|---|
| Temporary/exception access always expires | `CHECK` on `role_assignments` + `entitlement_assignments` (`*_expiry_required`) |
| Role-derived grants trace to their role; direct grants never claim one | `CHECK entitlement_assignments_source_matches_type` |
| At most one live grant per identity × role/entitlement | partial unique indexes `*_one_live` |
| Revocation is attributed (reason + timestamp) | `CHECK *_revoked_fields` |
| No self-approval, including via delegation | trigger `approvals_no_self_approval` |
| Request items target exactly one role or entitlement | `CHECK access_request_items_target_matches` |
| Provisioning jobs target exactly one object, retries are idempotent | `CHECK provisioning_jobs_exactly_one_target`, unique `idempotency_key` |
| Manual fulfillment confirmations are attributed + timestamped | `CHECK provisioning_jobs_manual_confirmation_complete` |
| Review decisions are attributed; each item reviews exactly one grant | `CHECK`s on `access_review_items` |
| Audit log is append-only | trigger `audit_events_append_only` blocks UPDATE/DELETE |
| Audit actions follow the `entity.verb` catalog format | `CHECK audit_events_action_format` |
| Service accounts have sponsors; contractors have end dates; privileged alt-accounts link to owners | `CHECK`s on `identities` |

## Table groups

- **Identity repository** — `identities`, `identity_accounts`, `lifecycle_events`
- **Catalog** — `applications`, `entitlements`, `business_roles`, `role_entitlements`, `role_assignment_rules`
- **Grant ledger** — `role_assignments`, `entitlement_assignments`, `policy_exceptions`
- **Governance** — `access_requests`, `access_request_items`, `approvals`, `access_review_campaigns`, `access_review_items`, `sod_rules`
- **Operations** — `provisioning_jobs`
- **Evidence** — `audit_events` (append-only)

Conventions: UUID PKs (`gen_random_uuid()`), `TIMESTAMPTZ` everywhere,
`created_at`/`updated_at` on all mutable tables (maintained by the
`set_updated_at` trigger), native Postgres enums mirrored 1:1 in
`@iam/domain`, `JSONB` only for connector payloads/filters/snapshots —
never for relational data, and never for secrets.
