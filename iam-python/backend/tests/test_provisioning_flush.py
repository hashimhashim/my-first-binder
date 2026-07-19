"""Regression test for the auto-approve provisioning bug.

Callers (e.g. an auto-approved access request) queue a provisioning job and
call run_pending_jobs() within the *same* transaction. The session runs with
autoflush=False (see database.py), so unless run_pending_jobs flushes first,
its SELECT never sees the just-queued job and the job is stranded at QUEUED —
the account never reaches the downstream connector.

This reproduces that exact shape with an in-memory SQLite DB and the
MOCK_DIRECTORY connector, and asserts the job actually runs.
"""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import AppAccount, Application, Employee
from app.services import provisioning


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    # Mirror production: autoflush OFF is what makes the flush in
    # run_pending_jobs load-bearing.
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()


def test_run_pending_jobs_sees_job_queued_in_same_transaction():
    db = _session()
    app = Application(name="Sim Dir", connector_type="MOCK_DIRECTORY", config={})
    emp = Employee(display_name="Ada", email="ada@example.com", department="SOC",
                   title="Analyst", status="ACTIVE", password_hash="x")
    db.add_all([app, emp])
    db.flush()
    account = AppAccount(employee_id=emp.id, application_id=app.id,
                         account_identifier=emp.email, status="PENDING")
    db.add(account)
    db.flush()

    # Queue the job WITHOUT committing, then run immediately — the exact
    # sequence the request auto-approve path uses.
    provisioning.queue_job(db, operation="CREATE_USER", application=app, employee=emp,
                           app_account=account, idempotency_key=f"CREATE_USER:{account.id}")
    result = provisioning.run_pending_jobs(db)

    assert result["completed"] == 1, result
    assert result["total"] == 1, result
    db.refresh(account)
    assert account.status == "ACTIVE"
