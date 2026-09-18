"""Directory Synchronization Engine endpoints: manual runs, run history, and
per-application sync settings."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import current_user, require_admin
from ..models import Application, SyncRun
from ..services import sync_engine

router = APIRouter(prefix="/api/sync", tags=["sync"])


def _serialize(run: SyncRun) -> dict:
    return {
        "id": run.id, "application_id": run.application_id,
        "application": run.application.name if run.application else None,
        "sync_type": run.sync_type, "trigger": run.trigger, "status": run.status,
        "started_at": run.started_at, "completed_at": run.completed_at,
        "accounts_scanned": run.accounts_scanned, "untracked_count": run.untracked_count,
        "missing_count": run.missing_count, "status_drift_count": run.status_drift_count,
        "group_drift_count": run.group_drift_count, "error": run.error,
    }


class RunBody(BaseModel):
    mode: str = "FULL"  # FULL | INCREMENTAL


@router.post("/{application_id}/run")
def run_now(application_id: str, body: RunBody, admin=Depends(require_admin), db: Session = Depends(get_db)):
    app = db.get(Application, application_id)
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "application not found")
    if body.mode not in ("FULL", "INCREMENTAL"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "mode must be FULL or INCREMENTAL")
    run = sync_engine.run_sync(db, app, mode=body.mode, trigger="MANUAL")
    return _serialize(run)


@router.get("/runs")
def list_runs(db: Session = Depends(get_db), _=Depends(current_user)):
    rows = db.scalars(select(SyncRun).order_by(SyncRun.started_at.desc()).limit(50))
    return [_serialize(r) for r in rows]


class SyncSettingsIn(BaseModel):
    sync_enabled: bool
    sync_interval_minutes: int = 15


@router.patch("/{application_id}/settings")
def update_settings(application_id: str, body: SyncSettingsIn, admin=Depends(require_admin), db: Session = Depends(get_db)):
    app = db.get(Application, application_id)
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "application not found")
    if body.sync_interval_minutes < 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "sync_interval_minutes must be >= 1")
    app.sync_enabled = body.sync_enabled
    app.sync_interval_minutes = body.sync_interval_minutes
    db.commit()
    return {"id": app.id, "sync_enabled": app.sync_enabled, "sync_interval_minutes": app.sync_interval_minutes}
