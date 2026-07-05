#!/bin/sh
# First boot: create + migrate + seed. Later boots: migrate only, keep data.
# RESET_DEMO=true forces a wipe + reseed.
set -e

export DATABASE_URL="postgres://postgres:postgres@db:5432/postgres"
npx tsx /app/apps/api/scripts/init.ts

echo "==> Starting IAM Platform — open http://localhost:8090"
cd /app/apps/api
DATABASE_URL="postgres://postgres:postgres@db:5432/iam_app" \
  PORT=8090 \
  npx tsx src/main.ts
