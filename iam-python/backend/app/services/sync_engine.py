"""Directory Synchronization Engine.

Pulls the current account list from a connector (`Connector.list_accounts`)
and diffs it against the provisioning ledger (`AppAccount`, one row per
identity+application+group entitlement) to detect drift:

  UNTRACKED_ACCOUNT  an account exists at the source with no matching ledger
                     row at all — created out-of-band, or a hire not yet
                     linked to this application.
  MISSING_AT_SOURCE  the ledger has a live account for this identity but the
                     source has nothing — provisioning didn't take, or the
                     account was removed by hand outside the platform.
  STATUS_DRIFT       the source's enabled/disabled state disagrees with our
                     employee's lifecycle status.
  GROUP_ADDED        a group membership exists at the source that our ledger
                     did not grant — rogue/out-of-band access.
  GROUP_MISSING      a group membership our ledger expects is absent at the
                     source — provisioning or manual removal drift.

Mirrors the platform's reconciliation philosophy: this module only *detects*
and records drift (via SyncRun + AuditEvent). It never mutates AppAccount,
Employee, or group state — remediation is a governance decision made through
the normal request/approval or lifecycle paths, not an automatic side effect
of a sync tick.

Two modes:
  FULL         connector.list_accounts(since=None) — every account, every time.
  INCREMENTAL  connector.list_accounts(since=<last_sync_cursor>) — only what
               the connector reports changed since the last run. Falls back
               to FULL automatically the first time a connector is synced.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..connectors import registry
from ..models import AppAccount, Application, Employee, SyncRun
from ..security import decrypt_credentials
from . import audit

LIVE_ACCOUNT_STATUSES = ("PENDING", "ACTIVE")


@dataclass
class LedgerAccount:
    """One identity's expected state for an application, built from AppAccount rows."""

    identifier: str
    email: str | None
    employee_id: str
    employee_status: str
    groups: set[str] = field(default_factory=set)


@dataclass
class Finding:
    kind: str  # UNTRACKED_ACCOUNT, MISSING_AT_SOURCE, STATUS_DRIFT, GROUP_ADDED, GROUP_MISSING
    identifier: str
    employee_id: str | None = None
    detail: str = ""


@dataclass
class DiffResult:
    accounts_scanned: int
    findings: list[Finding] = field(default_factory=list)

    def count(self, kind: str) -> int:
        return sum(1 for f in self.findings if f.kind == kind)


def compute_diff(source_accounts: list[dict], ledger: list[LedgerAccount]) -> DiffResult:
    """Pure diff function — no I/O, independently testable."""
    by_identifier = {l.identifier: l for l in ledger}
    by_email = {l.email: l for l in ledger if l.email}
    matched_identifiers: set[str] = set()

    findings: list[Finding] = []
    for src in source_accounts:
        ident = src.get("identifier")
        ledger_row = by_identifier.get(ident) or (by_email.get(src.get("email")) if src.get("email") else None)
        if ledger_row is None:
            findings.append(Finding(
                kind="UNTRACKED_ACCOUNT", identifier=ident,
                detail=f"account '{ident}' exists at source with no matching ledger entry",
            ))
            continue
        matched_identifiers.add(ledger_row.identifier)

        # Status drift: source disabled but our employee is still active, or
        # vice versa (source active but our employee is terminated).
        src_status = src.get("status", "ACTIVE")
        if src_status == "DISABLED" and ledger_row.employee_status == "ACTIVE":
            findings.append(Finding(
                kind="STATUS_DRIFT", identifier=ident, employee_id=ledger_row.employee_id,
                detail="source account is DISABLED but the employee is ACTIVE",
            ))
        elif src_status == "ACTIVE" and ledger_row.employee_status == "TERMINATED":
            findings.append(Finding(
                kind="STATUS_DRIFT", identifier=ident, employee_id=ledger_row.employee_id,
                detail="source account is ACTIVE but the employee is TERMINATED",
            ))

        # Group drift.
        source_groups = set(src.get("groups") or [])
        for grp in source_groups - ledger_row.groups:
            findings.append(Finding(
                kind="GROUP_ADDED", identifier=ident, employee_id=ledger_row.employee_id,
                detail=f"group '{grp}' present at source but not granted by the ledger",
            ))
        for grp in ledger_row.groups - source_groups:
            findings.append(Finding(
                kind="GROUP_MISSING", identifier=ident, employee_id=ledger_row.employee_id,
                detail=f"group '{grp}' granted by the ledger but absent at source",
            ))

    for ledger_row in ledger:
        if ledger_row.identifier not in matched_identifiers:
            findings.append(Finding(
                kind="MISSING_AT_SOURCE", identifier=ledger_row.identifier, employee_id=ledger_row.employee_id,
                detail=f"ledger expects account '{ledger_row.identifier}' but it is absent at source",
            ))

    return DiffResult(accounts_scanned=len(source_accounts), findings=findings)


def _build_ledger(db: Session, application_id: str) -> list[LedgerAccount]:
    rows = db.execute(
        select(AppAccount, Employee)
        .join(Employee, Employee.id == AppAccount.employee_id)
        .where(AppAccount.application_id == application_id, AppAccount.status.in_(LIVE_ACCOUNT_STATUSES))
    ).all()
    by_identifier: dict[str, LedgerAccount] = {}
    for account, employee in rows:
        ident = account.account_identifier or employee.email
        entry = by_identifier.get(ident)
        if entry is None:
            entry = LedgerAccount(
                identifier=ident, email=employee.email,
                employee_id=employee.id, employee_status=employee.status,
            )
            by_identifier[ident] = entry
        if account.group_name:
            entry.groups.add(account.group_name)
    return list(by_identifier.values())


def run_sync(db: Session, application: Application, *, mode: str = "FULL", trigger: str = "MANUAL") -> SyncRun:
    """Executes one sync run and persists the result. Never raises for
    ordinary connector failures — those land as a FAILED SyncRun."""
    if mode == "INCREMENTAL" and not application.last_sync_cursor:
        mode = "FULL"  # nothing to diff against yet; first run is always full

    run = SyncRun(application_id=application.id, sync_type=mode, trigger=trigger, status="RUNNING")
    db.add(run)
    db.flush()

    connector = registry.build(
        application.connector_type, application.config, decrypt_credentials(application.credentials_enc)
    )
    result = connector.list_accounts(since=application.last_sync_cursor if mode == "INCREMENTAL" else None)

    if not result.ok:
        run.status = "FAILED"
        run.error = result.detail
        run.completed_at = datetime.now(timezone.utc)
        audit.record(db, action="sync.failed", entity_type="application", entity_id=application.id,
                     detail={"sync_run_id": run.id, "mode": mode, "error": result.detail})
        db.commit()
        return run

    source_accounts = result.data.get("accounts", [])
    ledger = _build_ledger(db, application.id)
    diff = compute_diff(source_accounts, ledger)

    for f in diff.findings:
        audit.record(
            db, action=f"sync.{f.kind.lower()}", entity_type="app_account", entity_id=f.identifier,
            detail={"sync_run_id": run.id, "application_id": application.id,
                    "employee_id": f.employee_id, "detail": f.detail},
        )

    run.status = "COMPLETED"
    run.completed_at = datetime.now(timezone.utc)
    run.accounts_scanned = diff.accounts_scanned
    run.untracked_count = diff.count("UNTRACKED_ACCOUNT")
    run.missing_count = diff.count("MISSING_AT_SOURCE")
    run.status_drift_count = diff.count("STATUS_DRIFT")
    run.group_drift_count = diff.count("GROUP_ADDED") + diff.count("GROUP_MISSING")

    application.last_sync_at = run.completed_at
    cursor = result.data.get("cursor")
    if cursor:
        application.last_sync_cursor = cursor

    audit.record(db, action="sync.completed", entity_type="application", entity_id=application.id, detail={
        "sync_run_id": run.id, "mode": mode, "accounts_scanned": diff.accounts_scanned,
        "untracked": run.untracked_count, "missing": run.missing_count,
        "status_drift": run.status_drift_count, "group_drift": run.group_drift_count,
    })
    db.commit()
    return run


def due_applications(db: Session) -> list[Application]:
    """Applications whose scheduled sync interval has elapsed (or never ran)."""
    now = datetime.now(timezone.utc)
    due = []
    for app in db.scalars(select(Application).where(Application.sync_enabled.is_(True), Application.enabled.is_(True))):
        if app.last_sync_at is None:
            due.append(app)
            continue
        elapsed_minutes = (now - app.last_sync_at).total_seconds() / 60
        if elapsed_minutes >= app.sync_interval_minutes:
            due.append(app)
    return due
