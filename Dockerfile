# IAM Platform — API + UI image.
# Runs TypeScript directly via tsx (no build step). Postgres is a separate
# service; see docker-compose.yml.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm install

# Copy the rest of the source.
COPY . .

# Node entrypoint (exec form, no shell) — immune to Windows CRLF line endings.
EXPOSE 8090
CMD ["npx", "tsx", "apps/api/scripts/dockerStart.ts"]
