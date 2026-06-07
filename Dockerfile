# syntax=docker/dockerfile:1
#
# geo-seo-claude — single multi-stage image for the whole Bun workspace.
#
# Roles (one image, role selected by START COMMAND at deploy time — D-01/D-03):
#   API     (default CMD) : bun packages/api/dist/main.js      (PORT default 8080)
#   Worker  (override)    : bun packages/worker/dist/main.js   (no port; SIGTERM drain)
#   Migrate (pre-deploy)  : bun packages/db/scripts/migrate.ts (TS source; advisory-locked, idempotent)
#   Cron    (scheduled task) : bun packages/cron/dist/main.js  (one-shot; Coolify cron expr)
#
# Base image is PINNED to an exact oven/bun patch tag (D-02) — never :latest.
# Secrets are NEVER baked in — injected via Coolify env (D-07); .dockerignore drops .env*.

# ---------------------------------------------------------------------------
# deps — install the full workspace dependency tree (incl. dev) for the build.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.1-slim AS deps
WORKDIR /app

# Copy manifests first so the install layer caches across source changes.
COPY package.json bun.lock ./
COPY packages/core/package.json   ./packages/core/package.json
COPY packages/fetch/package.json  ./packages/fetch/package.json
COPY packages/db/package.json     ./packages/db/package.json
COPY packages/api/package.json    ./packages/api/package.json
COPY packages/worker/package.json ./packages/worker/package.json
COPY packages/cron/package.json   ./packages/cron/package.json
COPY examples/package.json        ./examples/package.json

RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile all 6 tsup packages (each emits dist/main.js).
# NEVER prune in the build stage (Pitfall 1/4) — tsup/typescript are dev deps.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN cd packages/core   && bun run build \
 && cd /app/packages/fetch  && bun run build \
 && cd /app/packages/db     && bun run build \
 && cd /app/packages/api    && bun run build \
 && cd /app/packages/worker && bun run build \
 && cd /app/packages/cron   && bun run build

# ---------------------------------------------------------------------------
# runtime — slim, non-root, production-pruned dependency tree.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.1-slim AS runtime
ENV NODE_ENV=production
# Install curl for Coolify in-container health checks (slim image has none).
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Bring in manifests + built workspace, then re-resolve with dev deps pruned.
# This drops @electric-sql/pglite, tsup, typescript, vitest (Pitfall 1) while
# KEEPING API runtime deps: hono, @hono/zod-openapi, @scalar/hono-api-reference,
# postgres (@geo/db) — /docs + /openapi.json are served in-code (06-REVIEWS #1).
COPY package.json bun.lock ./
COPY --from=build /app/packages ./packages
COPY examples/package.json ./examples/package.json
RUN bun install --frozen-lockfile --production

# Non-root (official oven/bun image ships an unprivileged `bun` user — T-06-03).
USER bun

EXPOSE 8080
# Bun is PID 1 via exec-form CMD and receives SIGTERM directly. The worker drains
# in-flight audits up to SHUTDOWN_GRACE_MS — Coolify stop grace MUST be >= that (D-09).
STOPSIGNAL SIGTERM

# No global HEALTHCHECK here (Pitfall 7): the default role is the API, which writes
# no heartbeat. Health is configured PER-RESOURCE in Coolify (worker uses
# scripts/worker-healthcheck.sh; API uses an HTTP probe). See plan 02 runbook.

# Default role = API. Worker/migrate are reached by overriding the start command.
CMD ["bun", "packages/api/dist/main.js"]

# ---------------------------------------------------------------------------
# tini fallback (D-09 / Q3) — ENABLE ONLY if Coolify cannot set `--init` per
# resource. Uncomment to make tini PID 1 and forward signals to Bun. Default is
# OFF because exec-form CMD already delivers SIGTERM to Bun directly.
# ---------------------------------------------------------------------------
# USER root
# RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
# USER bun
# ENTRYPOINT ["tini", "--"]
