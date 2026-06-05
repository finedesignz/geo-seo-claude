---
phase: 06-containerize-coolify-deploy
plan: 01
subsystem: deploy
tags: [docker, bun, coolify, worker, env, 12-factor]
requires: [05-01]
provides:
  - "Single multi-stage Dockerfile (deps→build→runtime) for the whole Bun workspace"
  - "Secret-free .dockerignore (excludes .env*, keeps .env.example + db migrations)"
  - "Worker liveness heartbeat file + scripts/worker-healthcheck.sh"
  - "Full 12-factor .env.example (13 named vars, no secret values)"
affects: [packages/worker]
tech-stack:
  added: [oven/bun:1.3.1-slim base image]
  patterns: [multi-stage build, role-by-start-command, production dep prune, file-based liveness heartbeat]
key-files:
  created: [Dockerfile, .dockerignore, scripts/worker-healthcheck.sh]
  modified: [packages/worker/src/worker.ts, .env.example]
decisions:
  - "One image; role (API/worker/migrate) selected by start-command override, no entrypoint branch script"
  - "No global Dockerfile HEALTHCHECK — health configured per-resource in Coolify"
  - "Bun is PID 1 via exec-form CMD; tini block left commented as --init fallback"
metrics:
  duration: ~15 min
  completed: 2026-06-04
requirements: [DEPLOY-01, DEPLOY-03]
---

# Phase 6 Plan 01: Container Artifacts Summary

Single multi-stage Dockerfile ships `@geo/api` + `@geo/worker` as one pinned `oven/bun:1.3.1-slim` image (role by start-command), with a secret-free build context, a worker liveness heartbeat, and a complete 12-factor `.env.example`.

## What was built

- **Dockerfile** (repo root): `deps` (frozen install) → `build` (`bun run --filter '*' build`, all 5 tsup packages) → `runtime` (`bun install --frozen-lockfile --production`, `USER bun`, `EXPOSE 8080`, `STOPSIGNAL SIGTERM`, default `CMD ["bun","packages/api/dist/main.js"]`). Production prune drops dev deps (`@electric-sql/pglite`, tsup, typescript, vitest) while keeping API runtime deps (`hono`, `@hono/zod-openapi`, `@scalar/hono-api-reference`, `postgres`). No global HEALTHCHECK. Commented tini fallback for `--init` (D-09/Q3).
- **.dockerignore**: excludes `.env` + `.env.*` (re-includes `!.env.example`), `.git`, `.planning`, `node_modules`, `**/dist`, tests/coverage, editor/OS cruft. `packages/db/migrations/**` intentionally retained for runtime migrate.
- **Worker heartbeat** (`packages/worker/src/worker.ts`): `WORKER_HEARTBEAT_FILE` (default `/tmp/worker-heartbeat`) resolved once; non-fatal `writeFileSync(String(Date.now()))` at the top of the poll loop (fresh even at concurrency cap). Surgical diff — loop otherwise untouched.
- **scripts/worker-healthcheck.sh**: `set -euo pipefail`; exit 1 on missing/stale heartbeat (`stat -c %Y` age vs `WORKER_HEARTBEAT_MAX_AGE_S`, default 60), exit 0 on fresh.
- **.env.example**: REQUIRED (DATABASE_URL, ANTHROPIC_API_KEY, GEO_API_KEYS) + API (PORT) + WORKER tunables (CONCURRENCY, POLL_INTERVAL_MS, LEASE_TTL_SECONDS, RECLAIM_INTERVAL_MS, MAX_ATTEMPTS, SCORING_TIMEOUT_MS, SHUTDOWN_GRACE_MS, SCORING_MODEL, WORKER_HEARTBEAT_FILE). Placeholders/defaults only.

## Env var audit (grep-verified)

Cross-checked against `packages/worker/src/main.ts` (lines 37–44, 67–74), `packages/worker/src/env.ts`, `packages/api/src/main.ts`, `packages/db/src/client.ts`. All 13 documented vars are code-read. `DEDUP_TTL` confirmed absent (hardcoded constant `DEDUP_TTL_MS` in `audit-post.ts`, Q5).

## Review dispositions honored (06-REVIEWS.md)

- **#1 (REJECTED)**: no filesystem `docs/` COPY added — `/docs` + `/openapi.json` served in-code (Scalar from in-memory spec). Verified production prune keeps `@scalar/hono-api-reference` + `hono` + `@hono/zod-openapi` (API `dependencies`, not dev) and `postgres` (`@geo/db` dependency). `@electric-sql/pglite` is a devDependency across packages → pruned. Classification correct.
- **#2 (FOLD)**: exact `.dockerignore` contents pinned; no blanket `*.md`.

## Validations run

- `bun run --filter '@geo/worker' build` → success.
- `bun run --filter '@geo/worker' test` → 5 files / 38 tests passed.
- `bash -n scripts/worker-healthcheck.sh` → syntax OK (shellcheck absent in env).
- Dockerfile/.dockerignore static checks: pinned `oven/bun:1.3`, default CMD = API, `--production` present, no uncommented HEALTHCHECK, `.env` excluded, `packages/db/migrations` retained — all pass.
- All 5 referenced package dirs (`api/core/db/fetch/worker`) exist and match COPY lines.

## Deferred Issues

- **`docker build` NOT run** — docker is unavailable in this environment (`command -v docker` → not found). The image build is deferred to the Coolify build (plan 03). Dockerfile was statically verified instead; all referenced paths/scripts exist. Base tag `oven/bun:1.3.1-slim` was NOT pulled-verified in-env — confirm it resolves at first Coolify build (fall back to highest stable `1.3.x-slim` if gone).

## Deviations from Plan

None — plan executed as written.

## Self-Check: PASSED

- Dockerfile, .dockerignore, scripts/worker-healthcheck.sh, .env.example exist.
- Commits: 133392b (Dockerfile/.dockerignore), 5fb7983 (worker heartbeat/healthcheck), 090b3f3 (.env.example).
