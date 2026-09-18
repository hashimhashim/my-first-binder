# Enterprise IAM Platform — Phase 1 Design

**Status:** Approved-pending-review · **Phase:** 1 (Design only, no implementation)
**Scope:** Identity Governance & Administration (IGA) platform for a Microsoft-centric environment.

---

## 1. Current-State Assessment

### 1.1 What exists today

The repository (`my-first-binder`) contains a blank **Remotion 4** video-rendering scaffold and nothing else:

| Area | Current state |
|---|---|
| Stack | TypeScript 6 / React 19 / Remotion 4 (video rendering studio, "Hello Remotion" composition) |
| Backend / API | None |
| Database / persistence | None — no ORM, no migrations, no DB config |
| AuthN / AuthZ | None — no login, no roles, no permissions |
| Workflow / approvals / audit | None |
| Microsoft / Entra integration | None |
| Tests / CI | None |

### 1.2 Implication

There are **no existing architecture patterns to reuse**. The only reusable asset is the TypeScript toolchain convention. The IAM platform is a **greenfield build inside this repository**; the Remotion scaffold is unrelated and should be left untouched (or removed later with the owner's consent).

### 1.3 IAM gap analysis (current vs. required)

Every required capability is a gap. The material ones, ranked by risk:

1. **No identity repository** — no system of record for employees, contractors, service or privileged accounts.
2. **No authorization model** — no RBAC, no entitlement catalog, no separation of business roles from technical entitlements.
3. **No access governance** — no request/approval workflow, no recertification, no SoD readiness.
4. **No audit trail** — no evidence chain for who requested/approved/granted/revoked what, when, and why.
5. **No lifecycle automation** — joiner/mover/leaver events are unmanaged; leavers would retain access indefinitely.
6. **No temporary/exception access controls** — nothing enforces expiry.
7. **No provisioning orchestration** — no application registry, no fulfillment tracking, no deprovisioning evidence.
8. **No Entra ID integration** — no OIDC sign-in, no Graph-based provisioning, no HR-source sync.

---

## 2. Target IAM Architecture

### 2.1 Architectural style

**API-first modular monolith** (single deployable, strict internal module boundaries), with an asynchronous worker for provisioning orchestration. A monolith is deliberate: IGA logic is transactional and cross-entity (a request approval touches grants, jobs, and audit atomically); microservices would add distributed-transaction pain with no benefit at internal-platform scale. Modules are boundary-clean so any one (e.g., provisioning) can be split out later.

### 2.2 Recommended stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Node.js 22 + TypeScript (strict)** | Matches repo toolchain; one language across API/workers/UI |
| API framework | **NestJS** | Module boundaries, DI, guards/interceptors for backend AuthZ, OpenAPI generation |
| Database | **PostgreSQL 16** | Transactional integrity, row-level constraints, JSONB for connector payloads. (Azure Database for PostgreSQL in a Microsoft cloud; Azure SQL is a viable swap if org policy mandates it — see Open Questions) |
| ORM / migrations | **Prisma** (or Drizzle) with SQL migrations checked in | Typed data access, reviewable migration history |
| Job queue | **pg-boss** (Postgres-backed) | Provisioning orchestration with retries/backoff, no extra infra (no Redis) |
| AuthN | **OIDC against Microsoft Entra ID** (auth-code + PKCE for UI; client-credentials for service callers); JWT validation server-side | Microsoft-centric SSO; MFA/Conditional Access inherited from Entra |
| AuthZ | **Backend-only RBAC guard layer**; platform permissions evaluated per request in the API | Working rule 6 |
| Entra provisioning | **Microsoft Graph SDK** connector (users, groups, app role assignments) | Entra readiness |
| UI (later phase) | React SPA (Vite) consuming the API only | API-first; UI has zero business logic |
| Tests | Vitest/Jest unit + integration (Testcontainers-Postgres) | Working rule 5 |

### 2.3 Module map

```
/apps
  /api            NestJS application (REST, OpenAPI)
  /worker         provisioning + lifecycle + expiry job processors
  /web            (Phase: UI) React SPA
/packages
  /domain         entities, state machines, invariants (pure TS, no IO)
  /db             Prisma schema, migrations, repositories
  /connectors     connector SDK + entra-graph + manual-fulfillment connectors
  /audit          append-only audit writer + redaction utilities
```

**Platform modules (inside `apps/api`):**

1. **Identity module** — identity repository, linked accounts, lifecycle state machine (JML).
2. **Catalog module** — applications, technical entitlements, business roles, role→entitlement mappings, role assignment rules.
3. **Access module** — the *grant ledger*: every entitlement a person holds, how they got it (role / request / exception), and until when.
4. **Request module** — self-service access requests + multi-stage approval engine.
5. **Review module** — recertification campaigns, review items, decisions, revocation follow-through.
6. **Provisioning module** — orchestration: turns approved grants/revocations into idempotent connector jobs with manual fallback.
7. **Audit module** — append-only event log, evidence export.
8. **Policy module** — exceptions, expiry enforcement, SoD rule scaffold.

### 2.4 Core design decisions (invariants)

These are enforced in the domain layer and by DB constraints, not by convention:

- **I1 — Business roles ≠ technical entitlements.** Users are assigned *business roles*; systems grant *technical entitlements*. Roles map to entitlements via `role_entitlements`. Direct entitlement grants exist only as governed exceptions.
- **I2 — Every non-role grant has an expiry.** `entitlement_assignments` with `assignment_type IN ('EXCEPTION','TEMPORARY')` have `NOT NULL expires_at` (DB CHECK constraint). The worker sweeps expiries daily and emits revocation jobs.
- **I3 — Every sensitive action writes an audit event, in the same DB transaction** as the state change. No audit row → transaction rolls back.
- **I4 — AuthZ is backend-only.** Every API route passes a permission guard; the UI merely hides buttons.
- **I5 — Provisioning is idempotent.** Jobs carry an `idempotency_key`; connectors must be safe to retry (Graph calls are check-then-act or natively idempotent).
- **I6 — The grant ledger is the source of truth for access**, not the target system. Reconciliation (later phase) detects drift between ledger and Entra/app reality.
- **I7 — No secrets in the database rows or logs.** Connector credentials live in Azure Key Vault (or env-injected secrets); audit payloads pass through a redaction filter; structured logging with a denylist of secret-shaped keys.

### 2.5 Capability designs

**Identity repository.** One `identities` table for all four types (EMPLOYEE, CONTRACTOR, SERVICE, PRIVILEGED) discriminated by `identity_type`, with manager, department, business unit, location, employment dates, and lifecycle status. Target-system accounts (Entra object, AD sAMAccountName, app-local accounts) live in `identity_accounts`, linked N:1 — a person can hold a standard and a privileged account, and service accounts have an owning human identity (`sponsor_identity_id`).

**JML workflows.**
- *Joiner:* identity created (API or HR/Entra sync) → status `PENDING` → activation triggers **birthright evaluation**: role assignment rules (e.g., department = Finance → role "Finance Base") auto-assign roles → provisioning jobs fan out.
- *Mover:* attribute change (dept/manager/BU) recorded as a `lifecycle_events` row → re-runs assignment rules → computes role delta → new roles provisioned, out-of-scope roles flagged for removal (auto or via mini-review, configurable) → non-transferable exceptions flagged for re-approval.
- *Leaver:* status → `LEAVING`/`TERMINATED` on `termination_date` → **all** active grants revoked, all accounts disabled via connectors, all open requests cancelled, review items auto-resolved as revoke. Deprovisioning completion is tracked per grant (evidence: every grant reaches `REVOKED` with a completed provisioning job or documented manual confirmation).
- Every transition is a `lifecycle_events` row + audit event; the state machine (`PENDING → ACTIVE → SUSPENDED ⇄ ACTIVE → LEAVING → TERMINATED`) rejects illegal jumps.

**Roles & entitlements.** Applications register their entitlements (Entra app roles, groups, app-local permissions) in a catalog with `risk_level` and owner. Business roles bundle entitlements. Role grant/revoke expands to entitlement-level provisioning jobs. SoD-ready: `sod_rules` table (entitlement/role pairs that conflict) evaluated at request time from day one, even if the rule set starts empty.

**Access requests & approvals.** Self-service request for a role, an entitlement (exception), or on-behalf-of. Approval chain is computed at submission from policy: **manager → application owner → security** (security stage required for `risk_level >= HIGH`, privileged targets, all exceptions, and SoD-flagged requests). Self-approval is blocked (requester ≠ approver; if approver is the requester's manager and also the app owner, stage collapses but a second human is still required for high risk — four-eyes). Approvals are per-stage rows with decision, comment, timestamp. Full trace: request → approvals → grant → provisioning job → audit events, all FK-linked.

**Temporary & exception access.** Both are `entitlement_assignments` rows (`TEMPORARY` = time-boxed role/entitlement from a normal request; `EXCEPTION` = direct entitlement outside any role, always requiring security approval and a `policy_exceptions` justification record). Both **must** carry `expires_at` (DB-enforced). Expiry sweep runs in the worker: warn at T-7/T-1 days (extension = new request), revoke at T-0 with provisioning jobs and audit events.

**Access reviews / recertification.** Campaigns scoped by application, role, risk level, or org unit. Snapshot at launch generates `access_review_items` (one per grant × reviewer). Reviewer = manager and/or app owner per campaign config. Decisions: `CERTIFY` or `REVOKE` (revoke fires the same revocation pipeline as expiry — reviews that don't revoke are theater). Escalation on reviewer inaction; configurable auto-revoke on campaign close for undecided high-risk items. Campaign export = compliance evidence pack.

**Provisioning orchestration.** Approved grant → `provisioning_jobs` row (`GRANT` or `REVOKE`, target connector, idempotency key, payload) → pg-boss worker executes connector with retry/backoff → terminal states `COMPLETED` / `FAILED` / `MANUAL_PENDING`. Applications with `fulfillment_mode = MANUAL` route to a fulfillment queue where an app admin confirms completion (timestamped, attributed — that confirmation *is* the evidence). Grant status transitions only on job completion: `PENDING_PROVISIONING → ACTIVE`, `PENDING_REVOCATION → REVOKED`.

**Audit & reporting.** Append-only `audit_events` (no UPDATE/DELETE grants on the table; optional hash chaining later). Event = actor (user or SYSTEM), action, entity type/id, before/after diff (redacted), correlation id, IP/user-agent, timestamp. Report endpoints: "who has access to X and why", "everything identity Y holds", orphaned accounts, grants-without-expiry-nearing-review, campaign evidence, leaver-deprovisioning proof.

**Entra ID integration (readiness now, connector in a later phase).**
- *Inbound:* Entra as OIDC IdP (AuthN) immediately; identity sync from Entra/HR via Graph delta queries later — connector interface defined now.
- *Outbound:* Graph connector implementing the connector SDK: create/disable users, group membership add/remove, app role assignment grant/revoke. App registration with least-privilege application permissions (`User.ReadWrite.All`, `Group.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All` — scoped tighter with administrative units where possible); secrets in Key Vault; managed identity when hosted in Azure.
- Every `entitlements` row can carry `external_ref` (Entra group objectId / appRoleId) so catalog entries bind 1:1 to Entra objects.

---

## 3. Data Model Proposal (core tables)

All tables: `id UUID PK`, `created_at`, `updated_at`; soft-delete only where noted (audit rows are never deleted).

### identities
| Column | Notes |
|---|---|
| identity_type | ENUM EMPLOYEE, CONTRACTOR, SERVICE, PRIVILEGED |
| employee_number | nullable, unique when present |
| display_name, given_name, family_name, primary_email (unique) | |
| manager_id | FK → identities, nullable |
| department, business_unit, location, job_title | |
| status | ENUM PENDING, ACTIVE, SUSPENDED, LEAVING, TERMINATED |
| start_date, termination_date | termination_date required for CONTRACTOR (CHECK) |
| sponsor_identity_id | FK → identities; required for SERVICE (CHECK) |
| source | ENUM MANUAL, HR_FEED, ENTRA_SYNC |
| linked_identity_id | FK → identities; links PRIVILEGED alt-account to its owner |

### identity_accounts
identity_id FK · application_id FK · account_identifier (UPN/objectId/username) · account_type ENUM(STANDARD, PRIVILEGED, SERVICE) · status ENUM(ACTIVE, DISABLED, DELETED) · external_ref JSONB · UNIQUE(application_id, account_identifier)

### applications
name (unique) · description · owner_identity_id FK · security_officer_identity_id FK nullable · connector_type ENUM(ENTRA_GRAPH, MANUAL, …) · fulfillment_mode ENUM(AUTOMATED, MANUAL) · criticality ENUM(LOW, MEDIUM, HIGH, CRITICAL) · status ENUM(ONBOARDING, ACTIVE, RETIRED) · connector_config JSONB (**no secrets** — Key Vault references only)

### entitlements  *(technical)*
application_id FK · code (unique per app) · name, description · risk_level ENUM(LOW, MEDIUM, HIGH, CRITICAL) · is_privileged BOOL · external_ref JSONB (Entra group/appRole ids) · status ENUM(ACTIVE, DEPRECATED)

### business_roles
code (unique) · name, description · owner_identity_id FK · risk_level · requires_security_approval BOOL · status

### role_entitlements  *(role → entitlement mapping)*
role_id FK · entitlement_id FK · UNIQUE(role_id, entitlement_id) · added_by, added_at (mapping changes are audited — they alter effective access for every holder)

### role_assignment_rules  *(birthright / attribute-based auto-assignment)*
role_id FK · attribute filter JSONB (e.g., `{"department": "Finance"}`) · priority · status

### role_assignments  *(identity ⇄ business role)*
identity_id FK · role_id FK · assignment_type ENUM(BIRTHRIGHT, REQUESTED, TEMPORARY) · granted_via_request_id FK nullable · starts_at · expires_at (**CHECK: NOT NULL when TEMPORARY**) · status ENUM(PENDING_PROVISIONING, ACTIVE, PENDING_REVOCATION, REVOKED) · revoked_reason ENUM(EXPIRY, LEAVER, MOVER, REVIEW, MANUAL, REQUEST)

### entitlement_assignments  *(the grant ledger — identity ⇄ technical entitlement)*
identity_id FK · entitlement_id FK · assignment_type ENUM(ROLE_DERIVED, EXCEPTION, TEMPORARY) · source_role_assignment_id FK nullable (**CHECK: required when ROLE_DERIVED**) · granted_via_request_id FK nullable · policy_exception_id FK nullable · starts_at · expires_at (**CHECK: NOT NULL when EXCEPTION or TEMPORARY**) · status (same lifecycle as role_assignments) · revoked_reason · UNIQUE partial index on (identity_id, entitlement_id) WHERE status IN ('ACTIVE','PENDING_PROVISIONING')

### access_requests
requester_identity_id FK · beneficiary_identity_id FK (on-behalf-of) · justification TEXT (required) · status ENUM(DRAFT, PENDING_APPROVAL, APPROVED, REJECTED, CANCELLED, PROVISIONED) · sod_flags JSONB · submitted_at, decided_at

### access_request_items
request_id FK · target_type ENUM(ROLE, ENTITLEMENT) · role_id / entitlement_id (CHECK: exactly one) · requested_duration / requested_expires_at · per-item status

### approvals
request_id FK · stage_order INT · stage_type ENUM(MANAGER, APP_OWNER, SECURITY) · approver_identity_id FK · delegated_to FK nullable · decision ENUM(PENDING, APPROVED, REJECTED, ESCALATED) · comment · decided_at · CHECK approver ≠ request beneficiary

### provisioning_jobs
job_type ENUM(GRANT, REVOKE, DISABLE_ACCOUNT, ENABLE_ACCOUNT, CREATE_ACCOUNT) · target: entitlement_assignment_id / role_assignment_id / identity_account_id (exactly one) · application_id FK · connector_type · idempotency_key (unique) · payload JSONB (redacted) · status ENUM(QUEUED, RUNNING, COMPLETED, FAILED, MANUAL_PENDING, MANUAL_CONFIRMED, CANCELLED) · attempt_count, last_error (redacted), completed_at · manual_confirmed_by FK nullable, manual_confirmed_at

### access_review_campaigns
name · scope JSONB (apps/roles/risk/org filters) · reviewer_strategy ENUM(MANAGER, APP_OWNER, BOTH) · starts_at, due_at · status ENUM(DRAFT, ACTIVE, CLOSING, CLOSED) · auto_revoke_on_close BOOL · created_by FK

### access_review_items
campaign_id FK · entitlement_assignment_id / role_assignment_id FK · reviewer_identity_id FK · snapshot JSONB (grant state at launch) · decision ENUM(PENDING, CERTIFIED, REVOKED, ESCALATED) · decided_at, comment · revocation_job_id FK nullable

### policy_exceptions
entitlement_assignment_id FK · exception_type ENUM(DIRECT_ACCESS, SOD_OVERRIDE, EXPIRY_EXTENSION) · justification TEXT · approved_by_security FK · expires_at **NOT NULL** · review_before DATE

### sod_rules  *(scaffold; evaluated at request time from day one)*
name · first/second target (role or entitlement) · severity ENUM(BLOCK, REQUIRE_APPROVAL, WARN) · status

### lifecycle_events
identity_id FK · event_type ENUM(JOINER, MOVER, LEAVER, SUSPEND, REINSTATE, ATTRIBUTE_CHANGE) · payload JSONB (before/after attributes) · triggered_by (user or SYSTEM/sync) · processed_at · resulting_actions JSONB

### audit_events  *(append-only; no UPDATE/DELETE privileges)*
occurred_at · actor_identity_id FK nullable · actor_type ENUM(USER, SYSTEM, CONNECTOR) · action VARCHAR (e.g., `access_request.approved`, `grant.revoked`) · entity_type, entity_id · correlation_id UUID · request_context JSONB (IP, UA — no tokens) · before JSONB, after JSONB (redacted) · Indexes: (entity_type, entity_id), (actor_identity_id, occurred_at), (action, occurred_at)

**Relationship spine:**
`identities 1─N identity_accounts N─1 applications 1─N entitlements N─M business_roles` (via role_entitlements); `identities N─M business_roles` via role_assignments; `identities N─M entitlements` via entitlement_assignments; `access_requests 1─N approvals`, `1─N access_request_items`; grants `1─N provisioning_jobs`; everything `1─N audit_events`.

---

## 4. Implementation Roadmap

| Phase | Deliverable | Contents | Exit criteria |
|---|---|---|---|
| **2** | Foundation & schema | Monorepo layout (apps/packages), NestJS skeleton, Postgres + Prisma, full migration set for §3, seed script, audit writer with transactional guarantee (I3), redaction utility, CI (lint/typecheck/test) | Migrations apply cleanly; audit invariant covered by tests |
| **3** | Identity domain + JML | Identity CRUD APIs, lifecycle state machine, lifecycle_events, linked accounts, birthright rule engine, leaver kill-switch (grant/job fan-out without connectors yet) | State-machine + leaver tests green; every mutation audited |
| **4** | Catalog & access model | Applications, entitlements, business roles, role_entitlements, role/entitlement assignment services with expiry CHECKs, expiry sweep worker (pg-boss), platform RBAC guards on all routes (I4) | Temp/exception grants impossible without expiry (DB + unit tests); AuthZ tests per route |
| **5** | Requests & approvals | Request submission, approval-chain computation, four-eyes/self-approval blocks, SoD evaluation hook, approve→grant→job pipeline, policy_exceptions | End-to-end request→grant integration test; rejection & cancellation paths audited |
| **6** | Provisioning orchestration | Connector SDK, manual-fulfillment connector + queue, idempotency, retry/backoff, grant-status transitions on job completion, deprovisioning evidence report | Idempotency tests (double-fire safe); manual confirmation flow audited |
| **7** | Entra connector | Graph connector (users, groups, appRoleAssignments), Key Vault secret handling, OIDC AuthN for the API/UI, entitlement external_ref binding; optional inbound delta sync | Sandbox-tenant integration test; zero secrets in logs verified |
| **8** | Access reviews | Campaigns, item generation snapshot, reviewer inbox APIs, decisions → revocation pipeline, escalation, evidence export | Campaign lifecycle e2e test; revoke decisions produce completed revocations |
| **9** | UI | React SPA: my-access, request wizard, approver inbox, reviewer inbox, admin (catalog/identities/campaigns), audit search | UI drives only public APIs; no authZ in UI |
| **10** | Hardening | Reconciliation (ledger vs Entra drift), SoD rule authoring UI, reporting pack, load/pen review, hash-chained audit option | Reconciliation report accurate on seeded drift |

Each phase lands as a reviewed PR with tests; critical IAM logic (state machines, expiry, approval chains, idempotency, audit invariant) gets unit + integration coverage.

---

## 5. Open Questions

1. **Stack confirmation** — TypeScript/NestJS + PostgreSQL is recommended (matches repo toolchain). If your org standard is .NET + Azure SQL, say so before Phase 2; the design maps 1:1 but the scaffold differs.
2. **Identity source of truth** — Is there an HR system (Workday/SuccessFactors/other) that should feed joiners, or is Entra ID / manual entry the inbound source for v1?
3. **Hosting target** — Azure (App Service/Container Apps + Azure DB + Key Vault + managed identity assumed)? Affects secret handling in Phase 7.
4. **Entra tenant for integration testing** — Is a sandbox tenant with an app registration available, and who grants admin consent for Graph application permissions?
5. **Repo intent** — This repo currently holds an unrelated Remotion scaffold. Build the IAM platform alongside it in a monorepo layout (assumed), or in a dedicated repo?
