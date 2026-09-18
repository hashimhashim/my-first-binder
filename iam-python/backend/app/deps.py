"""Shared FastAPI dependencies: current user and admin guard (backend authz)."""
from __future__ import annotations

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from .database import get_db
from .models import Employee
from .security import decode_token


def current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> Employee:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    payload = decode_token(authorization.split(" ", 1)[1])
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired token")
    if not payload.get("mfa_ok", True):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "MFA required")
    emp = db.get(Employee, payload["sub"])
    if emp is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unknown subject")
    return emp


def require_admin(user: Employee = Depends(current_user)) -> Employee:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "administrator role required")
    return user
