"""RBAC catalog: business roles, applications/connectors, role entitlements."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..connectors import registry
from ..database import get_db
from ..deps import current_user, require_admin
from ..models import Application, BusinessRole, RoleEntitlement
from ..security import decrypt_credentials, encrypt_credentials
from ..services import audit

router = APIRouter(prefix="/api", tags=["catalog"])


# --- roles -------------------------------------------------------------------
class RoleIn(BaseModel):
    code: str
    name: str
    description: str | None = None
    requires_approval: bool = True
    auto_assign_filter: dict = {}


@router.get("/roles")
def list_roles(db: Session = Depends(get_db), _=Depends(current_user)):
    out = []
    for r in db.scalars(select(BusinessRole).order_by(BusinessRole.name)):
        ents = [{"application_id": e.application_id, "application": e.application.name,
                 "group": e.group_name} for e in r.entitlements]
        out.append({"id": r.id, "code": r.code, "name": r.name, "description": r.description,
                    "requires_approval": r.requires_approval,
                    "auto_assign_filter": r.auto_assign_filter, "entitlements": ents})
    return out


@router.post("/roles", status_code=201)
def create_role(body: RoleIn, admin=Depends(require_admin), db: Session = Depends(get_db)):
    role = BusinessRole(**body.model_dump())
    db.add(role)
    audit.record(db, action="role.created", entity_type="business_role", entity_id=role.id,
                 actor_id=admin.id, detail={"code": role.code})
    db.commit()
    return {"id": role.id, "code": role.code}


class EntitlementIn(BaseModel):
    application_id: str
    group_name: str | None = None


@router.post("/roles/{role_id}/entitlements", status_code=201)
def add_entitlement(role_id: str, body: EntitlementIn, admin=Depends(require_admin), db: Session = Depends(get_db)):
    if db.get(BusinessRole, role_id) is None or db.get(Application, body.application_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "role or application not found")
    ent = RoleEntitlement(role_id=role_id, application_id=body.application_id, group_name=body.group_name)
    db.add(ent)
    audit.record(db, action="role.entitlement_added", entity_type="business_role", entity_id=role_id,
                 actor_id=admin.id, detail={"application_id": body.application_id, "group": body.group_name})
    db.commit()
    return {"id": ent.id}


# --- applications / connectors ----------------------------------------------
class AppIn(BaseModel):
    name: str
    description: str | None = None
    connector_type: str
    config: dict = {}
    credentials: dict = {}  # stored encrypted, never returned


@router.get("/connector-types")
def connector_types(_=Depends(current_user)):
    return registry.available_types()


@router.get("/applications")
def list_apps(db: Session = Depends(get_db), _=Depends(current_user)):
    return [
        {"id": a.id, "name": a.name, "connector_type": a.connector_type, "enabled": a.enabled,
         "health": a.health, "last_health_at": a.last_health_at, "config": a.config,
         "sync_enabled": a.sync_enabled, "sync_interval_minutes": a.sync_interval_minutes,
         "last_sync_at": a.last_sync_at}
        for a in db.scalars(select(Application).order_by(Application.name))
    ]


@router.post("/applications", status_code=201)
def create_app(body: AppIn, admin=Depends(require_admin), db: Session = Depends(get_db)):
    if body.connector_type not in {t["type"] for t in registry.available_types()}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "unknown connector type")
    app = Application(
        name=body.name, description=body.description, connector_type=body.connector_type,
        config=body.config, credentials_enc=encrypt_credentials(body.credentials) if body.credentials else None,
    )
    db.add(app)
    audit.record(db, action="application.created", entity_type="application", entity_id=app.id,
                 actor_id=admin.id, detail={"name": app.name, "connector": app.connector_type})
    db.commit()
    return {"id": app.id, "name": app.name}


@router.post("/applications/{app_id}/test")
def test_connection(app_id: str, admin=Depends(require_admin), db: Session = Depends(get_db)):
    app = db.get(Application, app_id)
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    connector = registry.build(app.connector_type, app.config, decrypt_credentials(app.credentials_enc))
    result = connector.test_connection()
    app.health = "HEALTHY" if result.ok else "DOWN"
    app.last_health_at = datetime.now(timezone.utc)
    audit.record(db, action="application.tested", entity_type="application", entity_id=app.id,
                 actor_id=admin.id, detail={"ok": result.ok, "detail": result.detail})
    db.commit()
    return {"ok": result.ok, "detail": result.detail, "health": app.health}
