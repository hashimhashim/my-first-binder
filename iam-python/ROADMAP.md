# Enterprise IAM — Build Roadmap

Turns the enterprise feature wishlist (SailPoint / Ping / Omada-class) into a
prioritized, phased plan. Each item is tagged:

- ✅ **Done** — built and running today
- 🟡 **Partial** — foundation exists, needs extension
- ⬜ **To build**

Effort is rough engineering time for one focused developer.

---

## Where we are today (foundation — DONE)

Two working systems on branch `claude/enterprise-iam-platform-r2ehfo`:

- **TypeScript IGA platform** (`apps/`, `packages/`): identity repo, JML
  automation, RBAC, access requests + multi-stage approvals, SoD, temporary/
  exception access, provisioning orchestration, **Entra/Graph connector**,
  OIDC sign-in, access reviews, append-only audit, reconciliation, web UI —
  151 tests.
- **Python/FastAPI + React module** (`iam-python/`): employee directory, JML,
  connector plugin framework (Mock AD, REST, SCIM, LDAP), RBAC, requests +
  approvals, provisioning, JWT + TOTP MFA, audit, dashboard, React UI.

This already covers the *core* of an IGA product. The roadmap below is about
reaching feature-parity breadth with commercial suites.

---

## Phase A — Connector breadth + sync engine  ·  ~3–4 weeks
The single highest-value area: every new system integrated through a connector.

| Feature | Status | Effort |
|---|---|---|
| Connector plugin framework | ✅ Done | — |
| Mock AD / REST / SCIM / LDAP connectors | ✅ Done | — |
| CSV import/export connector | ⬜ | 1 d |
| SQL database connector | ⬜ | 2 d |
| Microsoft 365 / Entra (Graph) — real | 🟡 (TS side done) | 3 d |
| Google Workspace connector | ⬜ | 2 d |
| Salesforce / ServiceNow (REST templates) | 🟡 (REST base done) | 2 d each |
| Linux (SSH), Windows local, VPN | ⬜ | 2–3 d each |
| SAP / Oracle | ⬜ | 4 d each |
| **Sync engine**: scheduled + full + incremental + change detection | 🟡 (run-on-demand done) | 5 d |
| Per-connector audit + health history | 🟡 (health done) | 2 d |

**Deliverable:** add a connector = drop in one class; schedule syncs that
detect new/updated/disabled/deleted users and group/role changes.

## Phase B — Authentication & Federation service  ·  ~3–4 weeks
Turn the platform into an IdP/SP, not just a provisioning engine.

| Feature | Status | Effort |
|---|---|---|
| Password auth + JWT | ✅ Done | — |
| TOTP MFA (authenticator apps) | ✅ Done | — |
| Login portal + session management | 🟡 (login done) | 3 d |
| SSO across apps | ⬜ | — |
| **OIDC / OAuth2 provider** (IdP role) | ⬜ | 5 d |
| **SAML 2.0** (IdP + SP) | ⬜ | 6 d |
| Email / SMS OTP | ⬜ | 2 d |
| Push, FIDO2 / Passkeys / WebAuthn | ⬜ | 5 d |
| Passwordless login | ⬜ | 3 d |
| Session controls: timeout, concurrent limit, logout-everywhere | ⬜ | 3 d |

**Deliverable:** apps delegate login to this platform via OIDC/SAML; users get
SSO + strong MFA.

## Phase C — Policy & Risk engine  ·  ~2–3 weeks
Dynamic access decisions (ABAC + conditional access + adaptive auth).

| Feature | Status | Effort |
|---|---|---|
| RBAC (roles → entitlements) | ✅ Done | — |
| Attribute-based auto-assignment | ✅ Done | — |
| **Policy engine**: IF/THEN rules (dept→role, contractor→90-day expiry, admin→always MFA) | 🟡 (birthright rules done) | 5 d |
| ABAC + conditional access | ⬜ | 4 d |
| **Risk engine**: new device, unknown country, impossible travel, TOR/VPN, failed-login patterns | ⬜ | 6 d |
| Risk actions: allow / step-up MFA / block / notify / lock | ⬜ | 3 d |

**Deliverable:** access adapts to context; risky logins get challenged or blocked.

## Phase D — Governance depth  ·  ~2 weeks
Rounds out the IGA side to enterprise audit standards.

| Feature | Status | Effort |
|---|---|---|
| Access requests + approval workflow | ✅ Done | — |
| Access certification / recertification campaigns | 🟡 (TS side done) | 4 d |
| Privileged access: JIT, temporary elevation, emergency (break-glass) | 🟡 (temp access done) | 5 d |
| Password rotation for privileged accounts | ⬜ | 3 d |
| Identity Hub: unified profile merging HR/AD/apps + login & access history | 🟡 (directory done) | 4 d |
| Application catalog with owner/risk/provisioning rules | 🟡 (apps registry done) | 3 d |

## Phase E — Self-service, sessions, dashboards, API  ·  ~2 weeks

| Feature | Status | Effort |
|---|---|---|
| Self-service password reset / change / unlock | 🟡 (connector ops done) | 3 d |
| Password policy + history + generator | ⬜ | 2 d |
| Active session tracking + force logout + revocation | ⬜ | 3 d |
| Authentication dashboard (logins, failures, MFA usage, risk events) | 🟡 (dashboard done) | 3 d |
| Full REST API (users/roles/apps/connectors/workflows/audit) | ✅ Done | — |
| API auth: OAuth2 + JWT + API keys | 🟡 (JWT done) | 2 d |
| Plugin framework for admin-added connectors/workflows | 🟡 (connector registry done) | 4 d |

---

## Suggested order (what to build next)

1. **Phase A sync engine + 2–3 real connectors** — biggest practical payoff;
   makes the platform actually manage real systems on a schedule.
2. **Phase B OIDC/SAML federation** — turns it into an IdP; unlocks SSO.
3. **Phase C policy + risk engine** — the "adaptive" differentiator.
4. **Phase D/E** — governance depth and operational polish.

Rough total to full parity: **3–4 months** of focused work. The architecture
already in place (connector plugins, RBAC, provisioning jobs, audit) means each
phase slots in without rework.

## How we'll work it

Pick a phase (or a single row). I build it in the existing codebase with tests,
run it end to end, and push — same as every phase so far. Say which one and
we start.
