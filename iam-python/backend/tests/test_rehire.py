"""Rehire brings a terminated identity back and re-enables its downstream
accounts through the connector — the mirror image of leaver.

Exercises the full JML re-entry cycle (joiner -> leaver -> rehire -> leaver)
against an in-memory DB and the MOCK_DIRECTORY connector, asserting the app
account status transitions ACTIVE -> DISABLED -> ACTIVE -> DISABLED. The last
transition also guards the unique disable idempotency key: a static key would
collide with the first termination and silently skip the second.
"""
from __future__ import annotations

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import AppAccount, Application, BusinessRole, Employee, RoleEntitlement
from app.services import lifecycle, provisioning


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()


def _account_status(db, emp) -> str | None:
    acct = db.scalar(
        select(AppAccount).where(AppAccount.employee_id == emp.id,
                                 AppAccount.group_name.is_(None))
    )
    return acct.status if acct else None


def test_joiner_leaver_rehire_cycle():
    db = _session()
    app = Application(name="Sim Dir", connector_type="MOCK_DIRECTORY", config={})
    emp = Employee(display_name="Ada", email="ada@example.com", department="SOC",
                   title="Analyst", status="PRE_HIRE", password_hash="x")
    db.add_all([app, emp])
    db.flush()
    role = BusinessRole(code="SOC_ANALYST", name="SOC Analyst", requires_approval=False,
                        auto_assign_filter={"department": "SOC"})
    db.add(role)
    db.flush()
    db.add(RoleEntitlement(role_id=role.id, application_id=app.id, group_name="SOC-Analyst"))
    db.commit()

    lifecycle.process_joiner(db, emp, actor_id=None)
    provisioning.run_pending_jobs(db)
    assert _account_status(db, emp) == "ACTIVE"

    lifecycle.process_leaver(db, emp, actor_id=None)
    provisioning.run_pending_jobs(db)
    assert emp.status == "TERMINATED"
    assert _account_status(db, emp) == "DISABLED"

    result = lifecycle.process_rehire(db, emp, actor_id=None)
    provisioning.run_pending_jobs(db)
    assert emp.status == "ACTIVE"
    assert result["accounts_reenabled"] >= 1
    assert _account_status(db, emp) == "ACTIVE"

    # Repeatable: a second termination must disable again (unique disable key).
    lifecycle.process_leaver(db, emp, actor_id=None)
    provisioning.run_pending_jobs(db)
    assert _account_status(db, emp) == "DISABLED"


def test_rehire_on_active_employee_is_noop():
    db = _session()
    emp = Employee(display_name="Bo", email="bo@example.com", department="SOC",
                   title="Analyst", status="ACTIVE", password_hash="x")
    db.add(emp)
    db.commit()
    result = lifecycle.process_rehire(db, emp, actor_id=None)
    assert result["accounts_reenabled"] == 0
    assert emp.status == "ACTIVE"
