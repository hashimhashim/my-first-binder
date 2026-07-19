# Enterprise IAM Module — Python / FastAPI + React

A production-shaped Identity & Access Management module: employee directory,
JML lifecycle, RBAC, an extensible connector framework, access-request
workflows, provisioning orchestration, MFA, audit, dashboards — FastAPI +
PostgreSQL backend, React frontend, Docker deployment.

## Run it (one command)

```bash
cd iam-python
docker compose up --build
```

Open **http://localhost:8010**. Sign in with a demo account
(`admin@contoso.com`, `mona@contoso.com`, or `alice@contoso.com`) — password
`Passw0rd!`. Data persists in a Docker volume across restarts.

## Run locally (without Docker)

```bash
# Postgres on :5432 with a database named iam_py
cd iam-python/backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export IAM_DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5432/iam_py
uvicorn app.main:app --reload --port 8000        # API + docs at /docs

cd ../frontend
npm install && npm run dev                        # UI on :5173 (proxies /api)
```

## Architecture

```
backend/app/
  main.py            FastAPI app, static SPA hosting, startup + seed
  config.py          env-driven settings (IAM_ prefix)
  database.py        SQLAlchemy engine/session
  models.py          Employee, BusinessRole, Application, RoleEntitlement,
                     RoleAssignment, AppAccount, AccessRequest, Approval,
                     ProvisioningJob, AuditEvent, LifecycleEvent
  security.py        JWT, password hashing, TOTP MFA, credential encryption
  deps.py            auth dependencies (current_user / require_admin)
  routers/           auth, employees (JML), catalog (RBAC+apps), requests,
                     dashboard (+ provisioning ops, audit, directory, reports)
  services/          audit, provisioning orchestration, lifecycle (JML+RBAC)
  connectors/        the plugin framework:
    base.py          Connector ABC + uniform operations + ConnectorResult
    registry.py      pluggable registry (add a class → integrate a system)
    mock_directory.py  simulated AD/Entra (lets JML run end to end)
    rest.py          generic REST connector (config-driven)
    scim.py          SCIM 2.0
    ldap_dir.py      LDAP / LDAPS / Active Directory
frontend/            React (Vite): dashboard, employees+JML, requests,
                     approvals, directory, applications, audit
```

## Connector framework

Every integration implements one interface with uniform operations —
`test_connection`, `sync_users`, `create/update/disable/delete_user`,
`assign/revoke_group`, plus optional `enable/reset_password/unlock/move_ou`.
One provisioning workflow drives them all, so a new application is a single
class registered in `registry.py`. Protocols included: **MOCK_DIRECTORY**
(simulated AD/Entra), **REST**, **SCIM 2.0**, **LDAP/LDAPS/AD**. OAuth/OIDC,
SAML, PowerShell and custom scripts slot in the same way.

## What's implemented

- **Identity**: central directory; lifecycle states Pre-Hire → Active →
  Transfer → Leave → Terminated; profile, department, manager, roles,
  app accounts.
- **JML**: Joiner (activate + birthright roles + auto-provision), Mover
  (recompute roles on attribute change), Leaver (revoke roles, disable all
  accounts).
- **RBAC**: business roles map to application entitlements/groups; assigning
  a role expands into provisioning jobs; attribute-based auto-assignment.
- **Access requests**: self-service for roles or temporary application
  access, configurable approval chain (manager → security), backend-enforced.
- **Provisioning**: idempotent jobs, retry with manual-queue fallback,
  connector health, run-on-demand and after each approval.
- **Directory ops**: create/update/disable/enable/reset-password/unlock/
  move-OU exposed through the connector interface.
- **Security**: JWT auth, TOTP MFA (enroll/activate/verify), role-based
  admin, encrypted connector credentials (never returned or logged),
  redacted audit detail, full REST API (`/docs`).
- **Dashboard & reports**: users, pending approvals, provisioning status,
  failed jobs, connector health, audit log, access-by-employee report.

## Notes

The mock directory connector makes AD/Entra behaviour observable without a
tenant; the REST/SCIM/LDAP connectors are real reference implementations you
point at live systems via each application's `config`/`credentials`.
Migrations use `create_all` on startup for the demo; swap in Alembic for
production schema versioning.
