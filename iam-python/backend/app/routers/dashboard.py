"""Dashboard, reports, audit log, provisioning ops, and directory view."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..connectors.mock_directory import directory_snapshot
from ..database import get_db
from ..deps import current_user, require_admin
from ..models import (
    AccessRequest,
    Application,
    Approval,
    AppAccount,
    AuditEvent,
    Employee,
    ProvisioningJob,
)
from ..services import provisioning

router = APIRouter(prefix="/api", tags=["dashboard"])


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), _=Depends(current_user)):
    def count(model, *where):
        stmt = select(func.count()).select_from(model)
        for w in where:
            stmt = stmt.where(w)
        return db.scalar(stmt)

    status_breakdown = dict(
        db.execute(select(Employee.status, func.count()).group_by(Employee.status)).all()
    )
    job_breakdown = dict(
        db.execute(select(ProvisioningJob.status, func.count()).group_by(ProvisioningJob.status)).all()
    )
    return {
        "employees": {
            "total": count(Employee),
            "by_status": status_breakdown,
        },
        "pending_approvals": count(Approval, Approval.decision == "PENDING"),
        "open_requests": count(AccessRequest, AccessRequest.status == "PENDING_APPROVAL"),
        "provisioning": {
            "by_status": job_breakdown,
            "failed": count(ProvisioningJob, ProvisioningJob.status == "FAILED"),
            "manual_pending": count(ProvisioningJob, ProvisioningJob.status == "MANUAL_PENDING"),
        },
        "applications": {
            "total": count(Application),
            "healthy": count(Application, Application.health == "HEALTHY"),
            "down": count(Application, Application.health == "DOWN"),
        },
        "active_accounts": count(AppAccount, AppAccount.status == "ACTIVE"),
    }


@router.get("/provisioning/jobs")
def jobs(db: Session = Depends(get_db), _=Depends(current_user)):
    rows = db.scalars(select(ProvisioningJob).order_by(ProvisioningJob.created_at.desc()).limit(100))
    out = []
    for j in rows:
        app = db.get(Application, j.application_id)
        out.append({"id": j.id, "operation": j.operation, "application": app.name if app else None,
                    "status": j.status, "attempts": j.attempts, "last_error": j.last_error,
                    "created_at": j.created_at})
    return out


@router.post("/provisioning/run")
def run_jobs(_=Depends(require_admin), db: Session = Depends(get_db)):
    return provisioning.run_pending_jobs(db)


@router.get("/audit")
def audit_log(db: Session = Depends(get_db), _=Depends(current_user)):
    rows = db.scalars(select(AuditEvent).order_by(AuditEvent.occurred_at.desc()).limit(100))
    return [{"occurred_at": e.occurred_at, "action": e.action, "entity_type": e.entity_type,
             "actor": e.actor_label if e.actor_id is None else e.actor_id, "detail": e.detail}
            for e in rows]


@router.get("/directory")
def directory(_=Depends(current_user)):
    """Simulated AD/Entra directory state (from the mock connector)."""
    return directory_snapshot()


@router.get("/reports/access-by-employee")
def access_report(db: Session = Depends(get_db), _=Depends(require_admin)):
    out = []
    for emp in db.scalars(select(Employee).where(Employee.status != "TERMINATED")):
        accounts = db.scalars(
            select(AppAccount).where(AppAccount.employee_id == emp.id, AppAccount.status == "ACTIVE")
        )
        out.append({"employee": emp.display_name, "department": emp.department,
                    "applications": [db.get(Application, a.application_id).name for a in accounts]})
    return out
