"""Self-service access requests + configurable approval workflow."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import current_user
from ..models import AccessRequest, Application, Approval, BusinessRole, Employee
from ..services import audit, lifecycle, provisioning

router = APIRouter(prefix="/api/requests", tags=["requests"])


class RequestIn(BaseModel):
    target_type: str  # ROLE | APPLICATION
    role_id: str | None = None
    application_id: str | None = None
    justification: str
    expires_at: datetime | None = None
    beneficiary_id: str | None = None  # defaults to requester


def _build_chain(db: Session, request: AccessRequest, beneficiary: Employee) -> list[Approval]:
    """Configurable chain: manager -> security (for roles requiring approval)."""
    stages: list[tuple[str, str]] = []
    if beneficiary.manager_id and beneficiary.manager_id != beneficiary.id:
        stages.append(("MANAGER", beneficiary.manager_id))
    requires_security = True
    if request.role_id:
        role = db.get(BusinessRole, request.role_id)
        requires_security = role.requires_approval if role else True
    if requires_security:
        admin = db.scalar(select(Employee).where(Employee.is_admin.is_(True)))
        if admin and admin.id != beneficiary.id:
            stages.append(("SECURITY", admin.id))
    approvals = []
    for i, (stage_type, approver_id) in enumerate(stages, start=1):
        ap = Approval(request_id=request.id, stage_order=i, stage_type=stage_type, approver_id=approver_id)
        db.add(ap)
        approvals.append(ap)
    return approvals


@router.post("", status_code=201)
def submit(body: RequestIn, user: Employee = Depends(current_user), db: Session = Depends(get_db)):
    if not body.justification.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "justification required")
    if body.target_type == "APPLICATION" and body.expires_at is None:
        # direct app access is exception access → must expire
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "direct application access must have an expiry date")
    beneficiary_id = body.beneficiary_id or user.id
    beneficiary = db.get(Employee, beneficiary_id)
    if beneficiary is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "beneficiary not found")

    req = AccessRequest(
        requester_id=user.id, beneficiary_id=beneficiary_id, target_type=body.target_type,
        role_id=body.role_id, application_id=body.application_id,
        justification=body.justification, expires_at=body.expires_at,
    )
    db.add(req)
    db.flush()
    chain = _build_chain(db, req, beneficiary)
    if not chain:  # no approver needed → auto-approve
        req.status = "APPROVED"
        _fulfill(db, req)
    audit.record(db, action="request.submitted", entity_type="access_request", entity_id=req.id,
                 actor_id=user.id, detail={"target": body.target_type})
    db.commit()
    return {"id": req.id, "status": req.status,
            "approvals": [{"stage": a.stage_type, "approver_id": a.approver_id} for a in chain]}


@router.get("/inbox")
def inbox(user: Employee = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(Approval).where(Approval.approver_id == user.id, Approval.decision == "PENDING")
    )
    out = []
    for ap in rows:
        req = ap.request
        if req.status != "PENDING_APPROVAL":
            continue
        earlier_pending = any(
            a.decision == "PENDING" and a.stage_order < ap.stage_order for a in req.approvals
        )
        ben = db.get(Employee, req.beneficiary_id)
        out.append({
            "request_id": req.id, "approval_id": ap.id, "stage": ap.stage_type,
            "ready": not earlier_pending, "beneficiary": ben.display_name,
            "justification": req.justification, "target_type": req.target_type,
        })
    return out


class DecisionBody(BaseModel):
    decision: str  # APPROVED | REJECTED
    comment: str | None = None


@router.post("/{request_id}/decision")
def decide(request_id: str, body: DecisionBody, user: Employee = Depends(current_user), db: Session = Depends(get_db)):
    req = db.get(AccessRequest, request_id)
    if req is None or req.status != "PENDING_APPROVAL":
        raise HTTPException(status.HTTP_409_CONFLICT, "request not awaiting approval")
    mine = next((a for a in req.approvals if a.approver_id == user.id and a.decision == "PENDING"), None)
    if mine is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no pending approval for you on this request")
    if any(a.decision == "PENDING" and a.stage_order < mine.stage_order for a in req.approvals):
        raise HTTPException(status.HTTP_409_CONFLICT, "earlier stages must decide first")

    mine.decision = body.decision
    mine.comment = body.comment
    mine.decided_at = datetime.now(timezone.utc)
    audit.record(db, action="approval.decided", entity_type="access_request", entity_id=req.id,
                 actor_id=user.id, detail={"stage": mine.stage_type, "decision": body.decision})

    if body.decision == "REJECTED":
        req.status = "REJECTED"
        req.decided_at = datetime.now(timezone.utc)
    elif not any(a.decision == "PENDING" for a in req.approvals):
        req.status = "APPROVED"
        req.decided_at = datetime.now(timezone.utc)
        _fulfill(db, req)
        provisioning.run_pending_jobs(db)
    db.commit()
    return {"status": req.status}


def _fulfill(db: Session, req: AccessRequest) -> None:
    beneficiary = db.get(Employee, req.beneficiary_id)
    if req.target_type == "ROLE" and req.role_id:
        role = db.get(BusinessRole, req.role_id)
        lifecycle.assign_role(
            db, beneficiary, role,
            assignment_type="TEMPORARY" if req.expires_at else "REQUESTED",
            expires_at=req.expires_at, request_id=req.id,
        )
    elif req.target_type == "APPLICATION" and req.application_id:
        from ..models import AppAccount
        app = db.get(Application, req.application_id)
        account = AppAccount(employee_id=beneficiary.id, application_id=app.id,
                             account_identifier=beneficiary.email, status="PENDING")
        db.add(account)
        db.flush()
        provisioning.queue_job(db, operation="CREATE_USER", application=app, employee=beneficiary,
                               app_account=account, idempotency_key=f"CREATE_USER:{account.id}")
    req.status = "PROVISIONED"
    audit.record(db, action="request.provisioned", entity_type="access_request", entity_id=req.id)
