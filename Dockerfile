# Gideon Books — one image runs the web application, the background worker
# and the migration step (see docker-compose.yml and docs/self-hosting.md).

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3200 \
    STORAGE_DIR=/data/storage
# PostgreSQL client tools for scripts/backup.sh, restore.sh and
# verify-restore.sh, from the PostgreSQL project's repository so their major
# version matches the server's (pg_dump refuses a newer server). Set PG_MAJOR
# to your server's major version; docker-compose.yml runs PostgreSQL 16.
ARG PG_MAJOR=16
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-${PG_MAJOR} \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system books && useradd --system --gid books --home /app books \
 && mkdir -p /data/storage && chown -R books:books /data
COPY --from=build --chown=books:books /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=books:books /app/node_modules ./node_modules
COPY --from=build --chown=books:books /app/.next ./.next
COPY --from=build --chown=books:books /app/public ./public
# Sources the migrate/worker/admin scripts run directly (through tsx).
COPY --from=build --chown=books:books /app/lib ./lib
COPY --from=build --chown=books:books /app/scripts ./scripts
COPY --from=build --chown=books:books /app/app ./app
COPY --from=build --chown=books:books /app/components ./components
USER books
EXPOSE 3200
VOLUME ["/data/storage"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3200/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "next", "start", "--port", "3200"]
