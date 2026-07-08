"""Employee directory + JML lifecycle endpoints."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import current_user, require_admin
from ..models import AppAccount, Employee, RoleAssignment
from ..services import audit, lifecycle, provisioning

router = APIRouter(prefix="/api/employees", tags=["employees"])


class EmployeeIn(BaseModel):
    display_name: str
    email: EmailStr
    department: str | None = None
    title: str | None = None
    location: str | None = None
    manager_id: str | None = None
    employee_number: str | None = None


def _serialize(emp: Employee) -> dict:
    return {
        "id": emp.id, "display_name": emp.display_name, "email": emp.email,
        "department": emp.department, "title": emp.title, "location": emp.location,
        "manager_id": emp.manager_id, "status": emp.status,
        "start_date": emp.start_date, "end_date": emp.end_date,
    }


@router.get("")
def list_employees(db: Session = Depends(get_db), _=Depends(current_user)):
    return [_serialize(e) for e in db.scalars(select(Employee).order_by(Employee.display_name))]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_employee(body: EmployeeIn, admin=Depends(require_admin), db: Session = Depends(get_db)):
    if db.scalar(select(Employee).where(Employee.email == body.email.lower())):
        raise HTTPException(status.HTTP_409_CONFLICT, "email already exists")
    emp = Employee(status="PRE_HIRE", **{**body.model_dump(), "email": body.email.lower()})
    db.add(emp)
    audit.record(db, action="employee.created", entity_type="employee", entity_id=emp.id,
                 actor_id=admin.id, detail={"email": emp.email})
    db.commit()
    return _serialize(emp)


@router.get("/{employee_id}")
def get_employee(employee_id: str, db: Session = Depends(get_db), _=Depends(current_user)):
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    roles = [
        {"role_id": ra.role_id, "code": ra.role.code, "type": ra.assignment_type,
         "status": ra.status, "expires_at": ra.expires_at}
        for ra in db.scalars(select(RoleAssignment).where(RoleAssignment.employee_id == emp.id))
    ]
    accounts = [
        {"application": a.application.name, "group": a.group_name, "status": a.status,
         "identifier": a.account_identifier}
        for a in db.scalars(select(AppAccount).where(AppAccount.employee_id == emp.id))
    ]
    return {**_serialize(emp), "roles": roles, "accounts": accounts}


# --- JML ---------------------------------------------------------------------
@router.post("/{employee_id}/joiner")
def joiner(employee_id: str, admin=Depends(require_admin), db: Session = Depends(get_db)):
    emp = _must_get(db, employee_id)
    result = lifecycle.process_joiner(db, emp, actor_id=admin.id)
    provisioning.run_pending_jobs(db)
    return result


class MoverBody(BaseModel):
    department: str | None = None
    title: str | None = None
    location: str | None = None
    manager_id: str | None = None


@router.post("/{employee_id}/mover")
def mover(employee_id: str, body: MoverBody, admin=Depends(require_admin), db: Session = Depends(get_db)):
    emp = _must_get(db, employee_id)
    result = lifecycle.process_mover(db, emp, body.model_dump(exclude_none=True), actor_id=admin.id)
    provisioning.run_pending_jobs(db)
    return result


@router.post("/{employee_id}/leaver")
def leaver(employee_id: str, admin=Depends(require_admin), db: Session = Depends(get_db)):
    emp = _must_get(db, employee_id)
    result = lifecycle.process_leaver(db, emp, actor_id=admin.id)
    provisioning.run_pending_jobs(db)
    return result


def _must_get(db: Session, employee_id: str) -> Employee:
    emp = db.get(Employee, employee_id)
    if emp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "employee not found")
    return emp
