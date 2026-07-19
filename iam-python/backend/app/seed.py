"""Seed a demo world: org, applications (connectors), roles with entitlements,
and one in-flight access request."""
from __future__ import annotations

from sqlalchemy import select

from .database import SessionLocal
from .models import (
    AccessRequest,
    Application,
    Approval,
    BusinessRole,
    Employee,
    RoleEntitlement,
)
from .security import hash_password
from .services import lifecycle, provisioning


def seed_if_empty() -> None:
    db = SessionLocal()
    try:
        if db.scalar(select(Employee).limit(1)) is not None:
            return  # already seeded; keep data

        def person(name, email, dept, title, manager=None, admin=False):
            e = Employee(display_name=name, email=email, department=dept, title=title,
                         manager_id=manager.id if manager else None, status="ACTIVE",
                         is_admin=admin, password_hash=hash_password("Passw0rd!"))
            db.add(e)
            db.flush()
            return e

        admin = person("IAM Admin", "admin@contoso.com", "Security", "IAM Engineer", admin=True)
        mona = person("Mona Manager", "mona@contoso.com", "Finance", "Finance Director")
        person("Sam Security", "sam@contoso.com", "Security", "Security Officer", mona)
        alice = person("Alice Analyst", "alice@contoso.com", "Finance", "Financial Analyst", mona)

        entra = Application(name="Microsoft Entra ID", connector_type="MOCK_DIRECTORY",
                            config={"tenant": "contoso.onmicrosoft.com"}, health="HEALTHY")
        m365 = Application(name="Microsoft 365", connector_type="MOCK_DIRECTORY", health="HEALTHY")
        jira = Application(name="Jira", connector_type="REST",
                           config={"base_url": "https://jira.example.com",
                                   "paths": {"create_user": "/rest/api/2/user"}})
        db.add_all([entra, m365, jira])
        db.flush()

        finance = BusinessRole(code="FIN_ANALYST", name="Finance Analyst",
                               requires_approval=True, auto_assign_filter={"department": "Finance"})
        db.add(finance)
        db.flush()
        db.add_all([
            RoleEntitlement(role_id=finance.id, application_id=entra.id, group_name="Finance-Reporting"),
            RoleEntitlement(role_id=finance.id, application_id=m365.id, group_name="M365-E5"),
        ])
        db.commit()

        # Alice joins → birthright Finance Analyst provisions her accounts.
        lifecycle.process_joiner(db, alice, actor_id=admin.id)
        provisioning.run_pending_jobs(db)

        # An in-flight request for Jira access, awaiting Mona's approval.
        req = AccessRequest(requester_id=alice.id, beneficiary_id=alice.id, target_type="APPLICATION",
                            application_id=jira.id, justification="Need Jira for the migration project",
                            expires_at=None, status="PENDING_APPROVAL")
        # Give it an expiry to satisfy the exception rule.
        from datetime import datetime, timedelta, timezone
        req.expires_at = datetime.now(timezone.utc) + timedelta(days=30)
        db.add(req)
        db.flush()
        db.add(Approval(request_id=req.id, stage_order=1, stage_type="MANAGER", approver_id=mona.id))
        db.commit()

        # Aegis SIEM as a managed application (when a SIEM URL is configured,
        # e.g. in docker-compose). Ships with a SOC Analyst role whose
        # birthright rule auto-provisions any SOC hire into the SIEM — so
        # hiring in IAM immediately shows up in the SIEM viewer.
        _seed_siem(db, admin)

        print("seeded demo world")
    finally:
        db.close()


def _seed_siem(db, admin) -> None:
    import os

    siem_url = os.environ.get("IAM_SIEM_URL")
    if not siem_url:
        return
    from .security import encrypt_credentials

    siem = Application(
        name="Aegis SIEM", connector_type="AEGIS_SIEM",
        config={"base_url": siem_url, "verify_provisioning": True, "delete_enabled": False},
        credentials_enc=encrypt_credentials({"token": os.environ.get("IAM_SIEM_TOKEN", "demo-siem-token")}),
        health="UNKNOWN", sync_enabled=True, sync_interval_minutes=5,
    )
    db.add(siem)
    db.flush()
    soc = BusinessRole(code="SOC_ANALYST", name="SOC Analyst", requires_approval=False,
                       auto_assign_filter={"department": "SOC"})
    db.add(soc)
    db.flush()
    db.add(RoleEntitlement(role_id=soc.id, application_id=siem.id, group_name="SOC-Analyst"))
    db.commit()
