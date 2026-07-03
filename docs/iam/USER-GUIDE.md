# IAM Platform — Setup & Operating Guide

How to install, run, configure, and operate the platform day to day. For the
architecture and data model see `PHASE1-DESIGN.md`; for schema details see
`packages/db/README.md`.

---

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22+ | workspaces monorepo, `npm` |
| PostgreSQL | 16+ | one database per environment |
| Microsoft Entra ID tenant | optional | only for production auth + real provisioning |

---

## 2. First-time setup (10 minutes)

```bash
# 1. Install dependencies (all workspaces)
npm install

# 2. Point at your Postgres and apply the schema
export DATABASE_URL=postgres://user:pass@host:5432/postgres
npm run db:migrate            # applies packages/db/migrations in order

# 3. Verify everything works on your machine
npm test                      # 151 tests, all run against real Postgres

# 4. Seed a demo environment and start the app (dev mode)
npm run seed --workspace @iam/api            # creates database iam_app
DATABASE_URL=postgres://user:pass@host:5432/iam_app npm start --workspace @iam/api

# 5. Open http://localhost:4000 and use the persona switcher (top right)
```

Migration rules: never edit an applied migration (the runner rejects checksum
drift) — add a new `NNNN_description.sql` file instead. Migrations are
transactional and safe to run concurrently (advisory-locked).

---

## 3. Personas, roles, and permissions

Sign-in maps **Entra app roles → platform permissions** (fail-closed: unknown
roles grant nothing). Defaults defined in `packages/entra/src/auth.ts`:

| App role | Meant for | Can do |
|---|---|---|
| `IAM.User` | everyone | see own access, browse catalog, submit/cancel requests |
| `IAM.Approver` | managers, app owners, security officers | decide approvals on requests where they are in the chain |
| `IAM.Fulfiller` | app admins | see the manual queue, confirm fulfillment |
| `IAM.Auditor` | audit/compliance | read identities, catalog, grants, requests, jobs |
| `IAM.Admin` | IAM engineering | everything, incl. catalog admin, lifecycle, reviews |

Dev mode (no Entra configured) authenticates with headers instead:
`x-dev-actor: <persona email>` and `x-dev-roles: IAM.User,IAM.Approver` —
the UI persona switcher sets these for you.

**Authorization is backend-only.** The UI only hides buttons; every call is
re-checked in the service layer, and 403s surface in the UI.

---

## 4. Standard workflows

### 4.1 Onboard an application (IAM.Admin)

1. Register the application: name, **owner identity**, **security officer**
   (required for any high-risk approvals), connector type
   (`ENTRA_GRAPH` or `MANUAL`), criticality.
   `connector_config` may only hold references (Key Vault secret *names*,
   tenant ids) — the platform rejects secret-shaped keys outright.
2. Register its **technical entitlements** with `risk_level`,
   `is_privileged`, and the Entra binding in `external_ref`
   (`{"entraGroupObjectId": "..."}` or
   `{"servicePrincipalId": "...", "appRoleId": "..."}`).
3. Bundle entitlements into **business roles** (`role_entitlements`).
   Keep roles business-meaningful ("Finance Analyst"), never 1:1 wrappers
   around single permissions.
4. Optional: add **birthright rules** (`createAssignmentRule`) so joiners
   and movers get the role automatically, e.g.
   `{"department": "Finance", "identityType": "EMPLOYEE"}`.

### 4.2 Joiner / Mover / Leaver

- **Joiner**: create the identity (`PENDING`), set it `ACTIVE` on day one.
  The lifecycle worker assigns matching birthright roles and provisioning
  fans out automatically. Link their Entra account
  (`identity_accounts.external_ref.objectId`) so the Graph connector can
  act — unlinked identities route to the manual queue instead of failing.
- **Mover**: update department/manager/etc. The worker adds newly-matching
  birthright roles and revokes ones no longer justified (reason `MOVER`).
  Requested/exception access is never auto-touched — recertify it in reviews.
- **Leaver**: set status to `LEAVING` (notice period) then `TERMINATED`, or
  `TERMINATED` directly. The kill-switch revokes all access (reason
  `LEAVER`), cancels open requests, and disables accounts. Verify completion
  in the jobs table: every grant should reach `REVOKED` with a completed or
  manually-confirmed job. `TERMINATED` is final — rehires are new joiners.

Rules of thumb: contractors **must** have a `termination_date`; service
accounts **must** have a human sponsor; privileged alt-accounts **must**
link to the person's standard identity. The database enforces all three.

### 4.3 Request access (any user)

1. **Request access** tab → justification (mandatory) → add items.
2. A **business role** is the normal path. A **direct entitlement** is
   exception access: it always requires an expiry date and always adds the
   security approval stage.
3. Submit. The approval chain is computed and shown immediately:
   manager → app owner(s) → security (security forced for privileged /
   high-risk / exceptions / SoD flags). SoD `BLOCK` conflicts refuse
   submission on the spot.
4. Track or cancel from the request trail; the requester can cancel any
   time before the final decision.

### 4.4 Approve (managers, app owners, security)

**Approvals** tab. Stages decide strictly in order — your buttons enable
only when it's your turn. Review the justification, items, expiry, and any
SoD flags. One rejection settles the whole request; the final approval
fulfills it in the same transaction (grants created, provisioning queued).
You can never approve access for yourself — the platform blocks it even if
the UI didn't.

### 4.5 Fulfill manually (app admins)

**Fulfillment** tab lists jobs for `MANUAL` applications and automated jobs
whose retries exhausted. Perform the change in the target system **first**,
then *Confirm done* — your confirmation is recorded with your name and a
timestamp and is the compliance evidence. Never confirm work you didn't do.

### 4.6 Run an access review (IAM.Admin creates, managers/owners decide)

1. Create a campaign: scope (applications / risk levels / departments),
   reviewer strategy (`MANAGER`, `APP_OWNER`, or `BOTH`), due date, and
   whether to `autoRevokeOnClose` (recommended: **on** — undecided items
   fail closed).
2. Activate — live grants in scope are snapshotted into reviewer items.
   Nobody ever reviews their own access.
3. Reviewers work the **Reviews** tab: *Certify* keeps access, *Revoke*
   queues real deprovisioning (reason `REVIEW`). Escalate stuck items to a
   different reviewer.
4. Close the campaign; export the evidence pack (`getCampaignEvidence`)
   for auditors: every item, decision, decider, timestamp, and audit event.

### 4.7 Reconcile against Entra (scheduled or on demand)

Run `reconcileEntraGroups` (worker/CLI) against each tenant. Triage the
three finding types:

- `ROGUE_ACCESS` — someone has access with no grant. Either remove it in
  Entra or legalize it via an exception request. Never ignore it.
- `MISSING_ACCESS` — a grant that isn't reflected in the tenant. Re-run the
  provisioning tick; investigate the job history if it persists.
- `UNLINKED_ACCOUNT` — link the identity's Entra account so it can be
  verified.

All findings are already in the audit log when you triage them.

---

## 5. Operations

### 5.1 The worker loop

Production runs these on a schedule (the API's `POST /api/provisioning/tick`
does all three, for dev):

| Task | Function | Suggested cadence |
|---|---|---|
| JML automation | `processLifecycleEvents` | every 1–5 min |
| Job fan-out | `enqueueProvisioningJobs` | every 1–5 min |
| Connector execution | `runProvisioningWorker` | every 1–5 min |
| Expiry sweep | `sweepExpiredGrants` | hourly |
| Reconciliation | `reconcileEntraGroups` | daily |

All are idempotent and safe to run concurrently (row locks / idempotency
keys / journal stamping).

### 5.2 Going to production with Entra

1. Create an app registration for the **API**: expose an application ID URI,
   define the five app roles above, assign users/groups to them.
2. Set `ENTRA_TENANT_ID` and `ENTRA_AUDIENCE` — the API switches from dev
   headers to verified bearer tokens automatically.
3. Create an app registration for the **connector** with application
   permissions `Group.ReadWrite.All` + `AppRoleAssignment.ReadWrite.All`
   (admin consent required; scope with administrative units where possible).
   Put its client secret in **Key Vault**; wire
   `ClientCredentialsTokenProvider` + `KeyVaultSecretProvider` and register
   `EntraGraphConnector` in place of the dev connector (`apps/api/src/main.ts`).
4. Never put credentials in `connector_config`, env-committed files, or
   logs — the platform actively rejects secret-shaped config keys, and the
   audit/logging path redacts secret-shaped values as defense in depth.

### 5.3 Evidence for auditors

- *Who has access to X and why*: grant ledger joined to roles/requests.
- *Full story of one request*: `GET /api/requests/:id` (trail: items,
  approvals with comments, resulting grants, audit events).
- *Leaver proof*: leaver's grants all `REVOKED` + completed jobs +
  `identity.leaver_processed` audit event.
- *Recertification*: campaign evidence pack.
- *Everything else*: `audit_events` — append-only, same-transaction,
  filterable by actor, action, entity, and correlation id.

### 5.4 Do / Don't

- **Do** grant through roles; reserve direct entitlements for genuine
  exceptions. **Don't** hand-edit grant rows — every change must flow
  through the services so state machines and audit hold.
- **Do** set `autoRevokeOnClose` on reviews. **Don't** let campaigns close
  with undecided high-risk items.
- **Do** treat reconciliation findings as incidents with owners.
- **Don't** share the `IAM.Admin` role broadly — it is itself privileged
  access, and it shows up in the audit log like everything else.
