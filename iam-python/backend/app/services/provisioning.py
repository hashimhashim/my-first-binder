"""Provisioning orchestration: turns desired app access into idempotent jobs
executed through connectors, and drives account state transitions."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..connectors import registry
from ..connectors.base import UserContext
from ..models import AppAccount, Application, Employee, ProvisioningJob
from ..security import decrypt_credentials
from . import audit

# operation -> connector method name
_OPS = {
    "CREATE_USER": "create_user",
    "UPDATE_USER": "update_user",
    "DISABLE_USER": "disable_user",
    "ENABLE_USER": "enable_user",
    "DELETE_USER": "delete_user",
    "ASSIGN_GROUP": "assign_group",
    "REVOKE_GROUP": "revoke_group",
    "RESET_PASSWORD": "reset_password",
    "UNLOCK_USER": "unlock_user",
}


def _user_context(emp: Employee, account: AppAccount | None = None) -> UserContext:
    return UserContext(
        employee_id=emp.id,
        display_name=emp.display_name,
        email=emp.email,
        department=emp.department,
        title=emp.title,
        account_identifier=(account.account_identifier if account else emp.email),
        group_name=(account.group_name if account else None),
    )


def queue_job(
    db: Session,
    *,
    operation: str,
    application: Application,
    employee: Employee | None,
    app_account: AppAccount | None,
    idempotency_key: str,
    payload: dict | None = None,
) -> ProvisioningJob:
    existing = db.scalar(
        select(ProvisioningJob).where(ProvisioningJob.idempotency_key == idempotency_key)
    )
    if existing is not None:
        return existing
    job = ProvisioningJob(
        operation=operation,
        application_id=application.id,
        employee_id=employee.id if employee else None,
        app_account_id=app_account.id if app_account else None,
        idempotency_key=idempotency_key,
        payload=payload or {},
    )
    db.add(job)
    audit.record(db, action="provisioning_job.queued", entity_type="provisioning_job",
                 entity_id=idempotency_key, detail={"operation": operation, "app": application.name})
    return job


# Execution order within a batch: the account object must exist before group
# or role memberships are added, and on removal the memberships come off before
# the account is disabled/deleted. Lower number runs first.
_OP_ORDER = {
    "CREATE_USER": 0, "ENABLE_USER": 1, "UPDATE_USER": 2, "ASSIGN_GROUP": 3,
    "RESET_PASSWORD": 4, "UNLOCK_USER": 4, "REVOKE_GROUP": 5, "DISABLE_USER": 6,
    "DELETE_USER": 7,
}


def run_pending_jobs(db: Session, *, max_attempts: int = 4) -> dict:
    """Execute all QUEUED/retryable jobs through their connectors."""
    jobs = list(
        db.scalars(
            select(ProvisioningJob).where(ProvisioningJob.status.in_(["QUEUED", "FAILED"]))
        )
    )
    # Deterministic dependency ordering (create-before-assign, revoke-before-
    # disable) regardless of insertion-timestamp ties.
    jobs.sort(key=lambda j: (_OP_ORDER.get(j.operation, 9), j.created_at))
    completed, failed, manual = 0, 0, 0
    for job in jobs:
        app = db.get(Application, job.application_id)
        emp = db.get(Employee, job.employee_id) if job.employee_id else None
        account = db.get(AppAccount, job.app_account_id) if job.app_account_id else None
        if app is None or not app.enabled:
            continue
        job.status = "RUNNING"
        job.attempts += 1
        try:
            connector = registry.build(app.connector_type, app.config, decrypt_credentials(app.credentials_enc))
            method = getattr(connector, _OPS[job.operation])
            ctx = _user_context(emp, account) if emp else None
            result = method(ctx) if ctx else connector.sync_users()
        except Exception as exc:  # noqa: BLE001
            result = None
            job.status = "FAILED"
            job.last_error = f"connector error: {exc}"

        if result is None:
            failed += 1
            continue
        if result.ok:
            job.status = "COMPLETED"
            job.completed_at = datetime.now(timezone.utc)
            job.result = {"detail": result.detail, **result.data}
            _apply_account_state(job, account)
            audit.record(db, action="provisioning_job.completed", entity_type="provisioning_job",
                         entity_id=job.idempotency_key, detail={"operation": job.operation})
            completed += 1
        elif result.retryable and job.attempts < max_attempts:
            job.status = "FAILED"
            job.last_error = result.detail
            failed += 1
        else:
            job.status = "MANUAL_PENDING"
            job.last_error = result.detail
            audit.record(db, action="provisioning_job.manual", entity_type="provisioning_job",
                         entity_id=job.idempotency_key, detail={"reason": result.detail})
            manual += 1
    db.commit()
    return {"completed": completed, "failed": failed, "manual": manual, "total": len(jobs)}


def _apply_account_state(job: ProvisioningJob, account: AppAccount | None) -> None:
    if account is None:
        return
    if job.operation in {"CREATE_USER", "ASSIGN_GROUP", "ENABLE_USER"}:
        account.status = "ACTIVE"
    elif job.operation == "DISABLE_USER":
        account.status = "DISABLED"
    elif job.operation in {"DELETE_USER", "REVOKE_GROUP"}:
        account.status = "DELETED"
