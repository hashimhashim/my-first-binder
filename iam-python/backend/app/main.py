"""FastAPI application entry point."""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .database import Base, engine
from .routers import auth, catalog, dashboard, employees, requests
from .seed import seed_if_empty

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


@app.on_event("startup")
def on_startup() -> None:
    Base.metadata.create_all(bind=engine)
    if get_settings().seed_on_start:
        seed_if_empty()
