"""ORM models for the IAM module.

Design mirrors the platform's governance principles: business roles are kept
separate from technical entitlements/app assignments, temporary access always
has an expiry, and every sensitive action is auditable.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


# --------------------------------------------------------------------------- identity
class Employee(Base, TimestampMixin):
    __tablename__ = "employees"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    employee_number: Mapped[str | None] = mapped_column(String, unique=True)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    department: Mapped[str | None] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String)
    location: Mapped[str | None] = mapped_column(String)
    manager_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    # PRE_HIRE, ACTIVE, TRANSFER, LEAVE, TERMINATED
    status: Mapped[str] = mapped_column(String, default="PRE_HIRE", nullable=False)
    start_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Auth
    password_hash: Mapped[str | None] = mapped_column(String)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    mfa_secret: Mapped[str | None] = mapped_column(String)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    manager: Mapped[Employee | None] = relationship(remote_side=[id])
    role_assignments: Mapped[list[RoleAssignment]] = relationship(
        back_populates="employee", cascade="all, delete-orphan"
    )
    app_accounts: Mapped[list[AppAccount]] = relationship(
        back_populates="employee", cascade="all, delete-orphan"
    )


# --------------------------------------------------------------------------- RBAC
class BusinessRole(Base, TimestampMixin):
    __tablename__ = "business_roles"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    code: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=True)
    # Auto-assignment rule: attribute filter, e.g. {"department": "Finance"}
    auto_assign_filter: Mapped[dict] = mapped_column(JSON, default=dict)

    entitlements: Mapped[list[RoleEntitlement]] = relationship(
        back_populates="role", cascade="all, delete-orphan"
    )


class Application(Base, TimestampMixin):
    __tablename__ = "applications"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    connector_type: Mapped[str] = mapped_column(String, nullable=False)  # e.g. MOCK_DIRECTORY, REST, SCIM
    # Non-secret config (endpoints, base DN...). Secrets stored encrypted in `credentials`.
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    credentials_enc: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Health: UNKNOWN, HEALTHY, DEGRADED, DOWN
    health: Mapped[str] = mapped_column(String, default="UNKNOWN")
    last_health_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Directory sync (see services/sync_engine.py)
    sync_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    sync_interval_minutes: Mapped[int] = mapped_column(Integer, default=15)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Opaque incremental watermark returned by the connector (e.g. a
    # timestamp or change-log token); cleared to force the next run to be FULL.
    last_sync_cursor: Mapped[str | None] = mapped_column(String)


class RoleEntitlement(Base):
    """A business role grants an application (optionally a specific group/license)."""

    __tablename__ = "role_entitlements"
    __table_args__ = (UniqueConstraint("role_id", "application_id", "group_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    role_id: Mapped[str] = mapped_column(ForeignKey("business_roles.id"), nullable=False)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id"), nullable=False)
    group_name: Mapped[str | None] = mapped_column(String)  # AD group / app role / license SKU
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    role: Mapped[BusinessRole] = relationship(back_populates="entitlements")
    application: Mapped[Application] = relationship()


class RoleAssignment(Base, TimestampMixin):
    __tablename__ = "role_assignments"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    role_id: Mapped[str] = mapped_column(ForeignKey("business_roles.id"), nullable=False)
    # BIRTHRIGHT, REQUESTED, TEMPORARY
    assignment_type: Mapped[str] = mapped_column(String, default="REQUESTED")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String, default="ACTIVE")  # ACTIVE, REVOKED
    granted_via_request_id: Mapped[str | None] = mapped_column(String)

    employee: Mapped[Employee] = relationship(back_populates="role_assignments")
    role: Mapped[BusinessRole] = relationship()


class AppAccount(Base, TimestampMixin):
    """A concrete account/entitlement an employee holds in a target application."""

    __tablename__ = "app_accounts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id"), nullable=False)
    account_identifier: Mapped[str | None] = mapped_column(String)  # UPN / DN / username
    group_name: Mapped[str | None] = mapped_column(String)
    external_ref: Mapped[dict] = mapped_column(JSON, default=dict)
    # PENDING, ACTIVE, DISABLED, DELETED
    status: Mapped[str] = mapped_column(String, default="PENDING")
    source_role_id: Mapped[str | None] = mapped_column(String)

    employee: Mapped[Employee] = relationship(back_populates="app_accounts")
    application: Mapped[Application] = relationship()


# --------------------------------------------------------------------------- workflows
class AccessRequest(Base, TimestampMixin):
    __tablename__ = "access_requests"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    requester_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    beneficiary_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    target_type: Mapped[str] = mapped_column(String, nullable=False)  # ROLE, APPLICATION
    role_id: Mapped[str | None] = mapped_column(ForeignKey("business_roles.id"))
    application_id: Mapped[str | None] = mapped_column(ForeignKey("applications.id"))
    justification: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # DRAFT, PENDING_APPROVAL, APPROVED, REJECTED, PROVISIONED, CANCELLED
    status: Mapped[str] = mapped_column(String, default="PENDING_APPROVAL")
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    approvals: Mapped[list[Approval]] = relationship(
        back_populates="request", cascade="all, delete-orphan"
    )


class Approval(Base, TimestampMixin):
    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    request_id: Mapped[str] = mapped_column(ForeignKey("access_requests.id"), nullable=False)
    stage_order: Mapped[int] = mapped_column(Integer, nullable=False)
    stage_type: Mapped[str] = mapped_column(String, nullable=False)  # MANAGER, APP_OWNER, SECURITY
    approver_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    decision: Mapped[str] = mapped_column(String, default="PENDING")  # PENDING, APPROVED, REJECTED
    comment: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    request: Mapped[AccessRequest] = relationship(back_populates="approvals")


class ProvisioningJob(Base, TimestampMixin):
    __tablename__ = "provisioning_jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    # CREATE_USER, UPDATE_USER, DISABLE_USER, DELETE_USER, ASSIGN_GROUP, REVOKE_GROUP, RESET_PASSWORD
    operation: Mapped[str] = mapped_column(String, nullable=False)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id"), nullable=False)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"))
    app_account_id: Mapped[str | None] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    idempotency_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    # QUEUED, RUNNING, COMPLETED, FAILED, MANUAL_PENDING
    status: Mapped[str] = mapped_column(String, default="QUEUED")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SyncRun(Base):
    """One execution of the directory sync engine against one application.

    Findings themselves (which account, what drifted) are written to
    AuditEvent — this row is the run-level summary the dashboard reads.
    """

    __tablename__ = "sync_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id"), nullable=False)
    sync_type: Mapped[str] = mapped_column(String, nullable=False)  # FULL, INCREMENTAL
    trigger: Mapped[str] = mapped_column(String, default="MANUAL")  # MANUAL, SCHEDULED
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # RUNNING, COMPLETED, FAILED
    status: Mapped[str] = mapped_column(String, default="RUNNING")
    accounts_scanned: Mapped[int] = mapped_column(Integer, default=0)
    untracked_count: Mapped[int] = mapped_column(Integer, default=0)
    missing_count: Mapped[int] = mapped_column(Integer, default=0)
    status_drift_count: Mapped[int] = mapped_column(Integer, default=0)
    group_drift_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)

    application: Mapped[Application] = relationship()


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    actor_id: Mapped[str | None] = mapped_column(String)
    actor_label: Mapped[str] = mapped_column(String, default="SYSTEM")
    action: Mapped[str] = mapped_column(String, nullable=False)
    entity_type: Mapped[str] = mapped_column(String, nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)


class LifecycleEvent(Base):
    __tablename__ = "lifecycle_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String, nullable=False)  # JOINER, MOVER, LEAVER
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
