# syntax=docker/dockerfile:1
#
# geo-seo-claude — single multi-stage image for the whole Bun workspace.
#
# Roles (one image, role selected by the GEO_ROLE env var via scripts/docker-entrypoint.sh):
#   GEO_ROLE=api    (default) : bun packages/api/dist/main.js      (PORT default 8080)
#   GEO_ROLE=worker           : bun packages/worker/dist/main.js   (no port; SIGTERM drain)
#   GEO_ROLE=cron             : bun packages/cron/dist/main.js     (one-shot; Coolify scheduled task)
#   Migrate (pre-deploy)      : bun packages/db/scripts/migrate.ts (TS source; advisory-locked, idempotent)
#
# NOTE: role is GEO_ROLE-driven (not a per-resource start command) because Coolify's
# Dockerfile build pack does not honor start-command overrides (verified 4.1.1).
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
# Pin the Claude Code CLI version (subscription scoring path). Override at build:
#   --build-arg CLAUDE_CODE_VERSION=x.y.z
ARG CLAUDE_CODE_VERSION=latest
# Install curl/wget for Coolify in-container health checks (slim image has none),
# plus Node.js + the Claude Code CLI used by the worker when SCORING_PROVIDER=cli.
# The `claude` binary authenticates via CLAUDE_CODE_OAUTH_TOKEN (subscription) —
# see packages/worker/src/cli-scorer.ts. API mode (SCORING_PROVIDER=api) ignores it.
# Shared image: api/cron roles carry the CLI too (harmless, unused by them).
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl wget ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Bring in manifests + built workspace, then re-resolve with dev deps pruned.
# This drops @electric-sql/pglite, tsup, typescript, vitest (Pitfall 1) while
# KEEPING API runtime deps: hono, @hono/zod-openapi, @scalar/hono-api-reference,
# postgres (@geo/db) — /docs + /openapi.json are served in-code (06-REVIEWS #1).
COPY package.json bun.lock ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts
COPY examples/package.json ./examples/package.json
RUN bun install --frozen-lockfile --production

# Non-root (official oven/bun image ships an unprivileged `bun` user — T-06-03).
USER bun

EXPOSE 8080
# Bun is PID 1 via exec-form CMD and receives SIGTERM directly. The worker drains
# in-flight audits up to SHUTDOWN_GRACE_MS — Coolify stop grace MUST be >= that (D-09).
STOPSIGNAL SIGTERM

# Role-aware HEALTHCHECK (D-06 follow-up): one image serves all roles, so
# scripts/healthcheck.sh dispatches on GEO_ROLE — worker uses the heartbeat
# check, api probes GET /healthz, cron/other exits 0 (no liveness signal
# between one-shot runs). Coolify's own per-resource health check config (if
# any) still applies on top of this; this exists so the image is self-healing
# even without a Coolify-side check.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD sh scripts/healthcheck.sh

# Role dispatch via GEO_ROLE (default api). See scripts/docker-entrypoint.sh — Coolify
# Dockerfile build pack does not honor per-resource start-command overrides, so the
# worker/cron roles are selected by setting GEO_ROLE in the Coolify resource env.
ENTRYPOINT ["sh", "scripts/docker-entrypoint.sh"]

# ---------------------------------------------------------------------------
# tini fallback (D-09 / Q3) — ENABLE ONLY if Coolify cannot set `--init` per
# resource. Uncomment to make tini PID 1 and forward signals to Bun. Default is
# OFF because exec-form CMD already delivers SIGTERM to Bun directly.
# ---------------------------------------------------------------------------
# USER root
# RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
# USER bun
# ENTRYPOINT ["tini", "--"]
