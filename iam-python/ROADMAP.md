# Enterprise IAM — Build Roadmap

Turns the enterprise feature wishlist (SailPoint / Ping / Omada-class) into a
prioritized, phased plan. **Microsoft identity ecosystem first** — AD, Entra
ID, LDAP, M365, HR feed — because that's the foundation nearly every real
enterprise deployment starts from, and every later connector (Google
Workspace, Salesforce, SAP, ...) reuses the same sync engine once it exists.

Each item is tagged:
- ✅ **Done** — built and running today
- 🟡 **Partial** — foundation exists, needs extension
- ⬜ **To build**

Effort is rough engineering time for one focused developer.

---

## Where we are today (foundation — DONE)

Two working systems on branch `claude/enterprise-iam-platform-r2ehfo`:

- **TypeScript IGA platform** (`apps/`, `packages/`): identity repo, JML
  automation, RBAC, access requests + multi-stage approvals, SoD, temporary/
  exception access, provisioning orchestration, **real Entra/Graph
  connector**, OIDC sign-in, access reviews, append-only audit,
  ledger↔Entra reconciliation, web UI — 151 tests.
- **Python/FastAPI + React module** (`iam-python/`): employee directory, JML,
  connector plugin framework (Mock AD, REST, SCIM, LDAP), RBAC, requests +
  approvals, provisioning, JWT + TOTP MFA, audit, dashboard, React UI.

This already covers the *core* of an IGA product. The roadmap below closes
the gap to full enterprise breadth, Microsoft-first.

---

## Phase A.0 — Prove the framework with the Aegis SIEM  ·  ✅ DONE

Before wiring external Microsoft systems, IAM manages the in-house **Aegis
SIEM** as its first downstream application — the test case that proves the
whole connector + provisioning architecture end to end. Every future
integration (AD, Entra ID, PAM, GRC, SOAR, …) is now just another connector
on this same proven path.

| Feature | Status |
|---|---|
| `AEGIS_SIEM` connector (create/update/disable/enable, config-gated delete, assign/remove role, sync list, provisioning verification) | ✅ Done |
| Hire in IAM → user created in SIEM with mapped role | ✅ Verified end to end |
| Terminate in IAM → user disabled in SIEM | ✅ Verified end to end |
| Role assignment synchronised (business role → SIEM role) | ✅ Verified |
| Directory sync of SIEM (drift detection) | ✅ Verified |
| Every action audited | ✅ |
| Automated tests (connector + sync diff) | ✅ 12 passing |
| Provisioning fix: `CREATE_USER` before `ASSIGN_GROUP`, deterministic op ordering | ✅ (benefits every connector) |

The connector points at a real Aegis SIEM by setting `config.base_url` +
`credentials.token`; override `config.paths` if the real API differs from the
documented default contract (see `connectors/aegis_siem.py`).

## Phase A — Microsoft Identity Foundation  ·  ~4 weeks

The base every later Microsoft phase depends on. With the framework now proven
against the SIEM, these are additional connectors on the same path.

| Feature | Status | Effort |
|---|---|---|
| **Directory Synchronization Engine** (scheduled + full + incremental, change detection: untracked/missing/status/group drift) | ✅ Done | — |
| **Active Directory connector** (LDAP/LDAPS bind, OU-aware, group sync) | 🟡 (generic LDAP connector done) | 3 d |
| **Microsoft Entra ID connector** (Graph API: users, groups, app role assignments) | ✅ Done (TypeScript side) / 🟡 (port into Python module) | 3 d |
| **Generic LDAP connector** | ✅ Done | — |
| **Microsoft 365 provisioning** (licenses, mailboxes via Graph) | ⬜ | 4 d |
| **HR System connector framework** (Workday/SuccessFactors-style feed → identity source of truth) | ⬜ | 5 d |
| **Identity reconciliation** (ledger vs. directory drift: rogue access, missing access, unlinked accounts) | ✅ Done (TypeScript side) / 🟡 (port into Python module) | 2 d |
| Scheduled sync (cron-style, per-connector cadence) | ⬜ | 2 d |
| Incremental sync (delta queries, watermarking) | ⬜ | 3 d |

**Deliverable:** the platform is the reliable system of record for
Microsoft-ecosystem identity — able to pull from AD/Entra/HR, detect drift,
and push changes back on a schedule, not just on manual action.

## Phase B — Authentication & Federation  ·  ~3–4 weeks

| Feature | Status | Effort |
|---|---|---|
| Password auth + JWT | ✅ Done | — |
| TOTP MFA | ✅ Done | — |
| **OIDC Provider** (IdP role) | ⬜ | 5 d |
| **OAuth2** | ⬜ | 3 d |
| **SAML 2.0** (IdP + SP) | ⬜ | 6 d |
| Passkeys / FIDO2 / WebAuthn | ⬜ | 5 d |
| Session management (timeout, concurrent limit, logout-everywhere) | 🟡 (login done) | 3 d |

**Deliverable:** apps delegate login to this platform via OIDC/SAML; SSO +
strong MFA across the enterprise.

## Phase C — Access Governance  ·  ~3 weeks

| Feature | Status | Effort |
|---|---|---|
| Access requests | ✅ Done | — |
| Provisioning orchestration | ✅ Done | — |
| Approval engine (multi-stage) | ✅ Done | — |
| SoD (segregation of duties) | ✅ Done (TypeScript side) / 🟡 (port into Python module) | 2 d |
| **JIT (just-in-time) privileged access** | ⬜ | 4 d |
| **Access reviews / recertification campaigns** | ✅ Done (TypeScript side) / 🟡 (port into Python module) | 3 d |

**Deliverable:** the full governance loop — request → approve → provision →
periodically recertify → auto-revoke — Microsoft-ecosystem-aware.

## Phase D — Conditional Access & Risk  ·  ~3 weeks

| Feature | Status | Effort |
|---|---|---|
| Attribute-based auto-assignment (birthright rules) | ✅ Done | — |
| **Conditional access policies** (device compliance, location, time-of-day) | ⬜ | 4 d |
| **Risk engine** (new device, unknown country, impossible travel, TOR/VPN detection, failed-login patterns) | ⬜ | 6 d |
| **Adaptive authentication** (step-up MFA / block / notify / lock based on risk) | ⬜ | 3 d |
| **UEBA / SIEM integration** (export risk & auth events to your SIEM) | ⬜ | 4 d |

**Deliverable:** access adapts to real-time risk; suspicious logins get
challenged, blocked, or flagged to security tooling automatically.

## Phase E — Dashboards, Reporting, API, SDK  ·  ~2 weeks

| Feature | Status | Effort |
|---|---|---|
| Dashboard (users, approvals, provisioning, connector health) | ✅ Done | — |
| Full REST API | ✅ Done | — |
| Authentication dashboard (logins, failures, MFA usage, risk events) | 🟡 | 3 d |
| Compliance/audit reporting exports | 🟡 (audit log done) | 2 d |
| **SDK** (typed client for the REST API) | ⬜ | 3 d |
| **Plugin framework** (admin-added connectors without touching core) | 🟡 (registry pattern exists) | 4 d |
| API auth: OAuth2 + JWT + API keys | 🟡 (JWT done) | 2 d |

## Phase F — Beyond Microsoft (after A–E mature)

Only once the Microsoft-ecosystem sync engine is solid does adding these
become cheap — same framework, new connector class each:

Google Workspace · Salesforce · ServiceNow · SAP · Oracle · VPN systems ·
Linux (SSH) · Windows local accounts · CSV import/export · SQL database.

---

## Suggested build order

1. **Phase A** — Directory Sync Engine + real AD/Entra/LDAP connectors +
   HR feed + reconciliation. *This is next.*
2. **Phase B** — OIDC/SAML federation → SSO.
3. **Phase C** — close the governance loop (JIT, recertification, SoD ported).
4. **Phase D** — conditional access + risk engine, the adaptive differentiator.
5. **Phase E** — polish: dashboards, SDK, plugin framework.
6. **Phase F** — broaden past Microsoft once the foundation is proven.

Rough total to full parity: **3–4 months** of focused work, Microsoft-first.

## How we'll work it

Pick an item from Phase A (or say "start Phase A") and I build it in the
existing codebase with tests, run it end to end, and push — same as every
phase so far.
