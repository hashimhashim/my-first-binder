"""Joiner / Mover / Leaver orchestration and RBAC expansion.

Assigning a business role expands into the concrete application accounts and
group memberships it entails, each provisioned via a connector job. Movers
recompute the delta; leavers revoke everything.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AppAccount,
    Application,
    BusinessRole,
    Employee,
    LifecycleEvent,
    RoleAssignment,
    RoleEntitlement,
)
from . import audit, provisioning


def _entitlements_for_roles(db: Session, role_ids: list[str]) -> list[RoleEntitlement]:
    if not role_ids:
        return []
    return list(db.scalars(select(RoleEntitlement).where(RoleEntitlement.role_id.in_(role_ids))))


def active_role_ids(db: Session, employee_id: str) -> list[str]:
    return list(
        db.scalars(
            select(RoleAssignment.role_id).where(
                RoleAssignment.employee_id == employee_id, RoleAssignment.status == "ACTIVE"
            )
        )
    )


def assign_role(
    db: Session,
    employee: Employee,
    role: BusinessRole,
    *,
    assignment_type: str = "REQUESTED",
    expires_at: datetime | None = None,
    request_id: str | None = None,
    actor_id: str | None = None,
) -> RoleAssignment:
    ra = RoleAssignment(
        employee_id=employee.id,
        role_id=role.id,
        assignment_type=assignment_type,
        expires_at=expires_at,
        granted_via_request_id=request_id,
    )
    db.add(ra)
    db.flush()
    audit.record(db, action="role.assigned", entity_type="employee", entity_id=employee.id,
                 actor_id=actor_id, detail={"role": role.code, "type": assignment_type})
    _provision_role(db, employee, role, actor_id=actor_id)
    return ra


def _ensure_account(db, employee, app, group_name, role_id):
    """Find or create the AppAccount row for an employee's account (group_name
    is None for the base account, or the specific group/role membership)."""
    account = db.scalar(
        select(AppAccount).where(
            AppAccount.employee_id == employee.id,
            AppAccount.application_id == app.id,
            AppAccount.group_name.is_(None) if group_name is None
            else AppAccount.group_name == group_name,
        )
    )
    if account is None:
        account = AppAccount(
            employee_id=employee.id, application_id=app.id,
            account_identifier=employee.email, group_name=group_name,
            source_role_id=role_id, status="PENDING",
        )
        db.add(account)
        db.flush()
    return account


def _provision_role(db: Session, employee: Employee, role: BusinessRole, *, actor_id: str | None) -> None:
    ents = _entitlements_for_roles(db, [role.id])
    provisioned_apps: set[str] = set()
    for ent in ents:
        app = db.get(Application, ent.application_id)
        # 1. The account object must exist before any group/role is added.
        #    Queue one CREATE_USER per application (idempotent), ahead of the
        #    group jobs (execution order is enforced in run_pending_jobs).
        if app.id not in provisioned_apps:
            provisioned_apps.add(app.id)
            base = _ensure_account(db, employee, app, None, role.id)
            provisioning.queue_job(
                db, operation="CREATE_USER", application=app, employee=employee,
                app_account=base, idempotency_key=f"CREATE_USER:{base.id}",
            )
        # 2. A group/role entitlement adds a membership to that account.
        if ent.group_name:
            account = _ensure_account(db, employee, app, ent.group_name, role.id)
            provisioning.queue_job(
                db, operation="ASSIGN_GROUP", application=app, employee=employee,
                app_account=account, idempotency_key=f"ASSIGN_GROUP:{account.id}",
            )


# --------------------------------------------------------------------------- JML
def process_joiner(db: Session, employee: Employee, *, actor_id: str | None = None) -> dict:
    employee.status = "ACTIVE"
    if employee.start_date is None:
        employee.start_date = datetime.now(timezone.utc)
    granted = _apply_birthright(db, employee, actor_id=actor_id)
    evt = LifecycleEvent(employee_id=employee.id, event_type="JOINER",
                         result={"birthright_roles": granted})
    db.add(evt)
    audit.record(db, action="lifecycle.joiner", entity_type="employee", entity_id=employee.id,
                 actor_id=actor_id, detail={"roles": granted})
    db.commit()
    return {"status": employee.status, "birthright_roles": granted}


def process_mover(db: Session, employee: Employee, changes: dict, *, actor_id: str | None = None) -> dict:
    before = {"department": employee.department, "title": employee.title}
    for field in ("department", "title", "location", "manager_id"):
        if field in changes and changes[field] is not None:
            setattr(employee, field, changes[field])
    employee.status = "ACTIVE"
    db.flush()

    desired = {r.id for r in _matching_roles(db, employee)}
    current = set(active_role_ids(db, employee.id))
    birthright_current = set(
        db.scalars(
            select(RoleAssignment.role_id).where(
                RoleAssignment.employee_id == employee.id,
                RoleAssignment.status == "ACTIVE",
                RoleAssignment.assignment_type == "BIRTHRIGHT",
            )
        )
    )
    added, removed = [], []
    for role_id in desired - current:
        role = db.get(BusinessRole, role_id)
        assign_role(db, employee, role, assignment_type="BIRTHRIGHT", actor_id=actor_id)
        added.append(role.code)
    for role_id in birthright_current - desired:
        _revoke_role(db, employee, role_id, reason="MOVER", actor_id=actor_id)
        removed.append(role_id)

    db.add(LifecycleEvent(employee_id=employee.id, event_type="MOVER",
                          payload={"before": before, "after": changes},
                          result={"roles_added": added, "roles_removed": removed}))
    audit.record(db, action="lifecycle.mover", entity_type="employee", entity_id=employee.id,
                 actor_id=actor_id, detail={"added": added, "removed": removed})
    db.commit()
    return {"roles_added": added, "roles_removed": removed}


def process_leaver(db: Session, employee: Employee, *, actor_id: str | None = None) -> dict:
    employee.status = "TERMINATED"
    employee.end_date = datetime.now(timezone.utc)
    # Revoke all active role assignments.
    role_ids = active_role_ids(db, employee.id)
    for role_id in role_ids:
        _revoke_role(db, employee, role_id, reason="LEAVER", actor_id=actor_id, skip_jobs=True)
    # Disable every live app account via connector jobs.
    accounts = list(
        db.scalars(
            select(AppAccount).where(
                AppAccount.employee_id == employee.id,
                AppAccount.status.in_(["PENDING", "ACTIVE"]),
            )
        )
    )
    for account in accounts:
        app = db.get(Application, account.application_id)
        provisioning.queue_job(
            db, operation="DISABLE_USER", application=app, employee=employee,
            app_account=account, idempotency_key=f"DISABLE_USER:{account.id}",
        )
    db.add(LifecycleEvent(employee_id=employee.id, event_type="LEAVER",
                          result={"roles_revoked": role_ids, "accounts_disabled": len(accounts)}))
    audit.record(db, action="lifecycle.leaver", entity_type="employee", entity_id=employee.id,
                 actor_id=actor_id, detail={"accounts_disabled": len(accounts)})
    db.commit()
    return {"accounts_disabled": len(accounts), "roles_revoked": len(role_ids)}


# --------------------------------------------------------------------------- helpers
def _matching_roles(db: Session, employee: Employee) -> list[BusinessRole]:
    out = []
    for role in db.scalars(select(BusinessRole)):
        flt = role.auto_assign_filter or {}
        if flt and all(getattr(employee, k, None) == v for k, v in flt.items()):
            out.append(role)
    return out


def _apply_birthright(db: Session, employee: Employee, *, actor_id: str | None) -> list[str]:
    granted = []
    current = set(active_role_ids(db, employee.id))
    for role in _matching_roles(db, employee):
        if role.id not in current:
            assign_role(db, employee, role, assignment_type="BIRTHRIGHT", actor_id=actor_id)
            granted.append(role.code)
    return granted


def _revoke_role(db, employee, role_id, *, reason, actor_id=None, skip_jobs=False):
    for ra in db.scalars(
        select(RoleAssignment).where(
            RoleAssignment.employee_id == employee.id,
            RoleAssignment.role_id == role_id,
            RoleAssignment.status == "ACTIVE",
        )
    ):
        ra.status = "REVOKED"
    if not skip_jobs:
        for account in db.scalars(
            select(AppAccount).where(
                AppAccount.employee_id == employee.id,
                AppAccount.source_role_id == role_id,
                AppAccount.status.in_(["PENDING", "ACTIVE"]),
            )
        ):
            app = db.get(Application, account.application_id)
            op = "REVOKE_GROUP" if account.group_name else "DISABLE_USER"
            provisioning.queue_job(
                db, operation=op, application=app, employee=employee, app_account=account,
                idempotency_key=f"{op}:{account.id}:{uuid.uuid4().hex[:8]}",
            )
    audit.record(db, action="role.revoked", entity_type="employee", entity_id=employee.id,
                 actor_id=actor_id, detail={"role_id": role_id, "reason": reason})
