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

# Normalise line endings on the shell entrypoint. Git on Windows may check
# the file out with CRLF, which the Linux shell cannot parse; strip any CR so
# the container runs regardless of the host OS.
RUN sed -i 's/\r$//' /app/docker/entrypoint.sh

EXPOSE 8090
CMD ["sh", "/app/docker/entrypoint.sh"]
