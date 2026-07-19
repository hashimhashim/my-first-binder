"""Lightweight startup migration.

The project uses `Base.metadata.create_all` for new tables, which is safe
for a fresh database but does not alter existing tables when a model gains a
column — a real concern once `docker compose`'s named volume starts
persisting data across image rebuilds. This adds any columns that
`create_all` would have created on a brand-new table, using Postgres's
`ADD COLUMN IF NOT EXISTS` so it's a no-op once applied.

Replace with Alembic once the schema needs anything more than additive
columns (renames, drops, backfills, constraints).
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

# (table, column, DDL type + default) — additive only.
_ADDITIVE_COLUMNS = [
    ("applications", "sync_enabled", "BOOLEAN DEFAULT FALSE"),
    ("applications", "sync_interval_minutes", "INTEGER DEFAULT 15"),
    ("applications", "last_sync_at", "TIMESTAMPTZ"),
    ("applications", "last_sync_cursor", "VARCHAR"),
]


def apply_additive_columns(engine: Engine) -> None:
    with engine.begin() as conn:
        for table, column, ddl in _ADDITIVE_COLUMNS:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {ddl}"))
