#!/bin/sh
# Seeds a fresh demo database, then starts the API + UI.
# Re-running (e.g. after a restart) resets to a clean, known demo state.
set -e

echo "==> Applying schema and seeding demo data..."
DATABASE_URL="postgres://postgres:postgres@db:5432/postgres" \
  npm run seed --workspace @iam/api

echo "==> Starting IAM Platform on http://localhost:4000"
DATABASE_URL="postgres://postgres:postgres@db:5432/iam_app" \
  PORT=4000 \
  npm start --workspace @iam/api
