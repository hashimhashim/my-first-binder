"""FastAPI application entry point."""
from __future__ import annotations

import asyncio
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .database import Base, SessionLocal, engine
from .migrate import apply_additive_columns
from .routers import auth, catalog, dashboard, employees, requests, sync
from .seed import seed_if_empty
from .services import sync_engine

logger = logging.getLogger("iam.scheduler")

app = FastAPI(title="Enterprise IAM Module", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(employees.router)
app.include_router(catalog.router)
app.include_router(requests.router)
app.include_router(dashboard.router)
app.include_router(sync.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "enterprise-iam"}


# Serve the built React frontend (present in the container image). Falls back
# to index.html for client-side routing. Skipped in local backend-only runs.
_STATIC_DIR = os.environ.get("IAM_STATIC_DIR", "/app/static")
if os.path.isdir(_STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(_STATIC_DIR, "assets")), name="assets")

    @app.get("/")
    def _index():
        return FileResponse(os.path.join(_STATIC_DIR, "index.html"))


# Scheduled sync: a lightweight in-process loop rather than a separate
# worker process/dependency (APScheduler, Celery, ...) — sufficient at this
# scale and keeps the container to a single process. Each tick runs any
# application whose sync_interval_minutes has elapsed (see
# sync_engine.due_applications); ticks never overlap and one application's
# failure never blocks another's.
_SCHEDULER_TICK_SECONDS = 30


async def _scheduler_loop() -> None:
    while True:
        await asyncio.sleep(_SCHEDULER_TICK_SECONDS)
        try:
            await asyncio.to_thread(_run_due_syncs)
        except Exception:  # noqa: BLE001 — the loop must survive a bad tick
            logger.exception("scheduled sync tick failed")


def _run_due_syncs() -> None:
    db = SessionLocal()
    try:
        for app_row in sync_engine.due_applications(db):
            mode = "INCREMENTAL" if app_row.last_sync_at else "FULL"
            try:
                sync_engine.run_sync(db, app_row, mode=mode, trigger="SCHEDULED")
            except Exception:  # noqa: BLE001 — one bad connector shouldn't stop the rest
                logger.exception("scheduled sync failed for application %s", app_row.id)
                db.rollback()
    finally:
        db.close()


@app.on_event("startup")
async def on_startup() -> None:
    Base.metadata.create_all(bind=engine)
    apply_additive_columns(engine)
    if get_settings().seed_on_start:
        seed_if_empty()
    if _SCHEDULER_TICK_SECONDS > 0 and os.environ.get("IAM_DISABLE_SCHEDULER") != "1":
        asyncio.create_task(_scheduler_loop())
