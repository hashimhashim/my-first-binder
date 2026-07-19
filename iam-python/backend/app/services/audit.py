"""Audit logging — one row per sensitive action, written in the caller's session."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import AuditEvent

# secret-shaped keys are redacted from audit detail
_SECRET_HINTS = ("password", "secret", "token", "credential", "key")


def _redact(value):
    if isinstance(value, dict):
        return {
            k: ("[REDACTED]" if any(h in k.lower() for h in _SECRET_HINTS) else _redact(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def record(
    db: Session,
    *,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    actor_id: str | None = None,
    actor_label: str = "SYSTEM",
    detail: dict | None = None,
) -> AuditEvent:
    event = AuditEvent(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        actor_id=actor_id,
        actor_label=actor_label,
        detail=_redact(detail or {}),
    )
    db.add(event)
    return event
