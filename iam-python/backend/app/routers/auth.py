"""Authentication: password login, MFA enrolment and verification."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import current_user
from ..models import Employee
from ..security import (
    create_access_token,
    mfa_provisioning_uri,
    new_mfa_secret,
    verify_password,
    verify_totp,
)
from ..services import audit

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    email: str
    password: str
    totp: str | None = None


@router.post("/login")
def login(body: LoginBody, db: Session = Depends(get_db)):
    emp = db.scalar(select(Employee).where(Employee.email == body.email.lower()))
    if emp is None or not verify_password(body.password, emp.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    mfa_ok = True
    if emp.mfa_enabled:
        if not body.totp:
            return {"mfa_required": True}
        if not verify_totp(emp.mfa_secret, body.totp):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid MFA code")
    token = create_access_token(emp.id, {"admin": emp.is_admin, "mfa_ok": mfa_ok})
    audit.record(db, action="auth.login", entity_type="employee", entity_id=emp.id, actor_id=emp.id)
    db.commit()
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"id": emp.id, "name": emp.display_name, "email": emp.email, "admin": emp.is_admin},
    }


@router.post("/mfa/enroll")
def mfa_enroll(user: Employee = Depends(current_user), db: Session = Depends(get_db)):
    secret = new_mfa_secret()
    user.mfa_secret = secret
    db.commit()
    return {"secret": secret, "otpauth_uri": mfa_provisioning_uri(secret, user.email)}


class MfaVerifyBody(BaseModel):
    totp: str


@router.post("/mfa/activate")
def mfa_activate(body: MfaVerifyBody, user: Employee = Depends(current_user), db: Session = Depends(get_db)):
    if not user.mfa_secret or not verify_totp(user.mfa_secret, body.totp):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid MFA code")
    user.mfa_enabled = True
    audit.record(db, action="auth.mfa_enabled", entity_type="employee", entity_id=user.id, actor_id=user.id)
    db.commit()
    return {"mfa_enabled": True}


@router.get("/me")
def me(user: Employee = Depends(current_user)):
    return {"id": user.id, "name": user.display_name, "email": user.email,
            "admin": user.is_admin, "mfa_enabled": user.mfa_enabled}
