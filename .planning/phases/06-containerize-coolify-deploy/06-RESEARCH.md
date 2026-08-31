# Phase 6: Containerize & Coolify Deploy - Research

**Researched:** 2026-06-04
**Domain:** Bun workspace-monorepo containerization (multi-stage Docker) + Coolify deploy/verify
**Confidence:** HIGH (codebase + Bun/Coolify docs verified) — a few Coolify-UI specifics flagged as open questions

## Summary

Phase 6 ships the already-built `@geo/api` (Bun.serve) and `@geo/worker` (poll loop) as ONE multi-stage Docker image, run as two Coolify resources off the same repo, role selected by start-command override. All decisions D-01..D-09 are LOCKED in CONTEXT.md — this research is implementation-ready *how*, not *whether*.

Verified from the codebase: every package builds with `tsup` emitting `dist/main.js` (ESM) + `dist/main.cjs` + `dist/index.*`. The API entry `packages/api/dist/main.js` is a `Bun.serve` default-export (honors `PORT`, default 8080, fail-fast on `GEO_API_KEYS`). The worker entry `packages/worker/dist/main.js` calls `assertEnv()` (DATABASE_URL + ANTHROPIC_API_KEY) first, installs its own `SIGTERM`/`SIGINT` handlers, drains in-flight up to `SHUTDOWN_GRACE_MS`, and `process.exit(1)` on fatal. Migrations run via `packages/db/scripts/migrate.ts` (`bun scripts/migrate.ts`) — advisory-locked (`pg_advisory_lock(6473656073656)`) and idempotent through `schema_migrations`, so it is safe as a one-shot pre-deploy command OR a boot-time fallback.

**Primary recommendation:** Single repo-root multi-stage `Dockerfile` on `oven/bun:1.3.1-slim`: stage `deps` (copy manifests + `bun.lock`, `bun install --frozen-lockfile`), stage `build` (copy sources, `bun run --filter '*' build`), stage `runtime` (copy resolved `node_modules` + every `packages/*/dist` + `packages/db/migrations`; default `CMD bun packages/api/dist/main.js`). Run worker by overriding the Coolify start command to `bun packages/worker/dist/main.js`; run migrations by overriding to `bun packages/db/scripts/migrate.ts`. Use Docker `--init` (Coolify/compose) for clean PID-1 signal/zombie handling — the worker's own handlers do the graceful drain.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTP audit API | API container (Bun.serve) | — | Stateless web tier, scaled independently |
| Audit scoring loop | Worker container | Postgres (lease/queue) | Long-running, no inbound port |
| Schema migrations | One-shot migrate command (same image) | Postgres advisory lock | Decoupled from app boot, race-safe |
| Job durability / redeploy safety | Postgres queue (Phase 3/4) | Worker lease/reclaim | Jobs persist, not in-memory |
| Secret injection | Coolify env | — | 12-factor, nothing baked in image |
| API liveness | Coolify HTTP health check → `/healthz` | — | Deep `SELECT 1` |
| Worker liveness | Heartbeat-file HEALTHCHECK | Coolify restart-on-exit | No HTTP port |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `oven/bun` base image | `1.3.1-slim` [VERIFIED: Docker Hub tags] | Build + runtime | Current stable 1.3.x slim; pin patch, never `:latest` (D-02) |
| `postgres` (postgres.js) | 3.4.9 [VERIFIED: packages/db/package.json] | Prod PG driver | Already the prod driver; ships in runtime |
| `tsup` | 8.5.1 [VERIFIED: package.json] | Per-package build | Emits `dist/main.js` ESM bin entries |

### Must NOT ship in runtime
| Library | Reason |
|---------|--------|
| `@electric-sql/pglite` 0.5.1 | **devDependency only** (test PG) [VERIFIED: all package.json `devDependencies`]. `bun install --frozen-lockfile` in the `deps` stage WILL install it; do not `bun install --production` mid-build (it would drop tsup/typescript needed for the build). Instead **build with full deps, then run `bun install --production --frozen-lockfile` in the runtime stage** to prune dev deps (pglite, tsup, vitest, typescript). See Pitfall 4. |

**Bun base image — confirm at plan time** (training/registry drift): re-check the highest stable tag with `docker run --rm oven/bun:1.3.1-slim bun --version` or the [Docker Hub tags page](https://hub.docker.com/r/oven/bun/tags). `1.3.1-slim` was the highest non-prerelease slim tag visible 2026-06-04 [VERIFIED: WebSearch Docker Hub]. `-slim` (Debian-slim) is preferred over `-alpine` for fewer native-module/musl surprises with postgres.js.

## Package Legitimacy Audit

No NEW external packages are introduced this phase — the Dockerfile installs the already-committed `bun.lock` closure. The only new "dependency" is the base image.

| Package | Registry | Disposition |
|---------|----------|-------------|
| `oven/bun:1.3.1-slim` (base image) | Docker Hub (official Oven team) | Approved — official Bun image, pin patch tag |
| (runtime npm closure) | npm via `bun.lock` | Approved — unchanged from Phases 1–5, `--frozen-lockfile` enforces it |

slopcheck not run: no new npm package names added. All runtime packages are the existing, reviewed lockfile closure.

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────────┐
   git push ───────▶│  Coolify (coolify.titaniumlabs.us)          │
                    │  Build Pack = Dockerfile  → ONE image         │
                    └───────────────┬─────────────────────────────┘
                                    │ same image, 3 run targets
          ┌─────────────────────────┼──────────────────────────────┐
          ▼                         ▼                                ▼
  ┌───────────────┐        ┌────────────────┐            ┌────────────────────┐
  │ API resource  │        │ Worker resource │            │ migrate (pre-deploy │
  │ CMD (default) │        │ start-cmd override          │ command / one-shot) │
  │ bun api/      │        │ bun worker/     │            │ bun db/scripts/     │
  │  dist/main.js │        │  dist/main.js   │            │  migrate.ts         │
  │ :8080         │        │ no port         │            │ exits 0             │
  └──────┬────────┘        └───────┬─────────┘            └─────────┬──────────┘
         │ /healthz (HTTP)         │ heartbeat-file HEALTHCHECK     │ pg_advisory_lock
         │                         │ /tmp/worker-heartbeat          │
         ▼                         ▼                                ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │            Coolify Postgres (one per app, rule 17)  DATABASE_URL           │
  │   audits queue (FOR UPDATE SKIP LOCKED) · leases/reclaim · schema_migrations│
  └──────────────────────────────────────────────────────────────────────────┘

  External: ANTHROPIC_API_KEY (worker→Anthropic) · GEO_API_KEYS (api bearer auth)
```

### Recommended Dockerfile (repo root)

```dockerfile
# syntax=docker/dockerfile:1
# ── deps: resolve workspace install from manifests only (max layer caching) ──
FROM oven/bun:1.3.1-slim AS deps
WORKDIR /app
# Copy only manifests + lockfile first so this layer is cached unless deps change.
COPY package.json bun.lock ./
COPY packages/core/package.json   packages/core/package.json
COPY packages/fetch/package.json  packages/fetch/package.json
COPY packages/db/package.json     packages/db/package.json
COPY packages/api/package.json    packages/api/package.json
COPY packages/worker/package.json packages/worker/package.json
RUN bun install --frozen-lockfile

# ── build: compile every workspace package with tsup ──
FROM deps AS build
WORKDIR /app
COPY . .
# Build all packages (each package.json has "build": "tsup")
RUN bun run --filter '*' build

# ── runtime: slim image, prod deps only, built dist + migrations ──
FROM oven/bun:1.3.1-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Manifests + lockfile so we can prune to production deps deterministically.
COPY package.json bun.lock ./
COPY --from=build /app/packages ./packages
# Prune dev deps (drops @electric-sql/pglite, tsup, vitest, typescript).
RUN bun install --frozen-lockfile --production
# Drop privileges — the official image ships a non-root `bun` user.
USER bun
EXPOSE 8080
# Default role = API. Worker/migrate override this command in Coolify.
CMD ["bun", "packages/api/dist/main.js"]
```

**Why this order / these choices** [CITED: bun.com/docs/guides/ecosystem/docker — multi-stage + `--frozen-lockfile` + non-root `bun` user]:
- Manifest-only copy in `deps` → install layer only invalidates when a `package.json`/`bun.lock` changes, not on every source edit (D-01 layer caching).
- `bun run --filter '*' build` builds all 5 packages in one step; `workspace:*` symlinks are resolved by the `deps` install and preserved because we copy the whole `packages/` tree (with each `dist/`) into runtime, then re-resolve with `--production` (D-04 keeps full resolved closure minus dev deps).
- `--production` in **runtime only** (never in `build`) — `tsup`/`typescript` are devDeps and are needed to build; pruning before build would break it (Pitfall 4).
- Run commands target `dist/main.js` (ESM) — confirmed by `tsup.config.ts` `entry: ["src/index.ts","src/main.ts"]`, `format: ["esm","cjs"]` for api + worker [VERIFIED: tsup configs].

### Run commands (D-03) — verified against tsup output

| Role | Command | Source |
|------|---------|--------|
| API (default CMD) | `bun packages/api/dist/main.js` | `@geo/api` bin `geo-api → ./dist/main.js` [VERIFIED] |
| Worker (override) | `bun packages/worker/dist/main.js` | `@geo/worker` bin `geo-worker → ./dist/main.js` [VERIFIED] |
| Migrate (override / pre-deploy) | `bun packages/db/scripts/migrate.ts` | `@geo/db` script `migrate` [VERIFIED]; resolves `migrations/` package-relative |

> Note: `migrate.ts` is run as **source** (`scripts/migrate.ts`), not from `dist/` — it is a script, not a tsup entry. It imports `../src/client.js` + `../src/migrate.js`; since the whole `packages/db` tree (incl. `src/`) is copied into runtime, Bun runs the TS source directly. `MIGRATIONS_DIR` is resolved relative to the script file, so it finds `packages/db/migrations/*.sql` regardless of cwd [VERIFIED: scripts/migrate.ts lines 18-21].

### PID 1 / signal handling (Pitfall 8 / D-09)

The worker installs `process.on("SIGTERM"/"SIGINT")` handlers [VERIFIED: worker.ts lines 54-55] and drains gracefully. When the runtime CMD is `bun <file>` (exec form, no shell wrapper), Bun runs as PID 1 and **does receive** the SIGTERM (no intermediate shell to swallow it). The remaining gap is **zombie reaping** + guaranteed forwarding semantics. Recommended: enable an init.

- **Coolify:** set the resource to run with Docker init (compose `init: true`, or `--init`). If Coolify doesn't expose `--init` per-resource (open question Q3), add `tini`:
  ```dockerfile
  # optional, in runtime stage if --init not available via Coolify:
  USER root
  RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
  USER bun
  ENTRYPOINT ["tini", "--"]
  ```
  With `tini` as ENTRYPOINT, CMD/start-command overrides still work (tini just forwards). [CITED: github.com/krallin/tini — forwards SIGTERM to child, reaps zombies]
- Add `STOPSIGNAL SIGTERM` (default already) and ensure **Coolify stop grace ≥ `SHUTDOWN_GRACE_MS` (default 30000ms)** so the drain completes (D-09, success criterion #4). Docker default stop grace is 10s — **too short**; must be raised to ≥30s (open question Q4 — confirm Coolify exposes this).

### Anti-Patterns to Avoid
- **Entrypoint branch script** (`if [ "$ROLE" = worker ]`) — D-03 explicitly rejects this; Coolify per-resource start-command override is the switch.
- **`bun install --production` in the build stage** — drops tsup; build fails (Pitfall 4).
- **Migrations silently on every API boot by default** — D-05 prefers explicit one-shot; boot-time guarded run is the *fallback* only.
- **`:latest` or unpinned base** — D-02.
- **Shipping pglite** — test-only; pruned by runtime `--production`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Concurrent migration safety | Custom lock table | Existing `pg_advisory_lock` runner | Already advisory-locked + idempotent [VERIFIED: migrate.ts] |
| Role switching | Entrypoint shell dispatcher | Coolify start-command override (D-03) | Less drift, no branch logic |
| Signal forwarding / zombie reaping | Shell trap wrapper | Docker `--init` / `tini` | Battle-tested PID-1 init |
| Job durability across redeploy | In-memory retry | Postgres queue + lease/reclaim (Phase 3/4) | Already structurally satisfied (D-09) |
| Worker HTTP health endpoint | Add an HTTP server to worker | Heartbeat file + HEALTHCHECK (D-06) | Worker has no port by design |

## Worker liveness heartbeat (D-06)

**Minimal worker change:** touch a heartbeat file once per poll-loop iteration. The natural insertion point is the top of the `while (!shuttingDown)` loop in `packages/worker/src/worker.ts` (line 67), guarded by an env-configured path.

```ts
// in worker.ts, before/at top of the poll loop body:
import { writeFileSync } from "node:fs";
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/worker-heartbeat";
// ...inside while loop:
try { writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch { /* non-fatal */ }
```

**Healthcheck script** `scripts/worker-healthcheck.sh` (or inline) + Dockerfile HEALTHCHECK. Stale = older than 2× `POLL_INTERVAL_MS` floor, with a sane minimum (poll default is 1000ms; use a generous threshold to avoid flapping while a long audit runs and the loop is at concurrency cap — note the loop still iterates every `pollIntervalMs` even when full, so the heartbeat keeps fresh):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD test "$(( $(date +%s) - $(stat -c %Y "${WORKER_HEARTBEAT_FILE:-/tmp/worker-heartbeat}") ))" -lt 60 || exit 1
```

> HEALTHCHECK in the Dockerfile applies to ALL roles from this image — including the API. Since the API also benefits from a process check but Coolify drives the API via HTTP `/healthz`, and Coolify's Dockerfile HEALTHCHECK **takes precedence over the UI** [CITED: coolify.io/docs/knowledge-base/health-checks], prefer NOT baking a global HEALTHCHECK. Instead: set the worker's heartbeat check as the worker **resource's** health command in Coolify, and the API's health check as HTTP `GET /healthz` in the API resource. Leave the Dockerfile without a global HEALTHCHECK (open question Q2 — confirm Coolify lets you set a per-resource non-HTTP/exec health command; if not, fall back to Coolify restart-on-exit for the worker, which D-06 accepts).

## Coolify specifics

[CITED: coolify.io/docs/builds/packs/dockerfile · coolify.io/docs/knowledge-base/health-checks · coolify.io/docs/applications]

- **Build Pack = Dockerfile**: point the resource at the repo; Coolify builds the root `Dockerfile`. Set the build context to repo root.
- **Two services off one repo**: create **two Coolify Application resources** from the same git repo/Dockerfile — API resource (default CMD) and worker resource (custom start command `bun packages/worker/dist/main.js`). Custom start command is set in the resource UI ("you can overwrite the default commands by setting a custom value on the UI"). *Alternative:* a `docker-compose.yml` build pack with `api` + `worker` services both `build: .` and different `command:` — viable but D-01/D-03 prefer the two-resource pattern. (Open question Q1 — confirm two separate resources can share a build cache / which is the operator's standing pattern.)
- **Migrations**: Coolify "Pre-deployment command" runs in a container with `sh -c` before deploy [CITED: Coolify docs]. Set it to `bun packages/db/scripts/migrate.ts`. Idempotent + advisory-locked → safe. Documented fallback (D-05): guarded boot-time run.
- **Health checks**: Dockerfile `HEALTHCHECK` takes precedence over UI when both defined. API resource → HTTP health check `GET /healthz` (200/503). Worker → exec/heartbeat (Q2).
- **Env injection**: set all secrets in each resource's Environment Variables (never committed). `.dockerignore` must exclude `.env`.
- **Coolify API** (base `https://coolify.titaniumlabs.us`, token in `~/.claude/secrets/services.json`): trigger redeploy via `POST /api/v1/deploy?uuid=<app-uuid>` (per global rule 22). App/Postgres **provisioning + secret entry is operator-owned (Human Gate)** — the API can trigger deploys and read status, but creating the resources + entering secrets is UI/operator work. Capture app UUIDs + Coolify-internal `DATABASE_URL` after provisioning.

**Genuinely requires Coolify UI/operator (Human Gate, per CONTEXT.md):** provision app + Postgres; enter `DATABASE_URL`/`ANTHROPIC_API_KEY`/`GEO_API_KEYS`; configure the two resources + per-resource start command + health check; confirm stop grace ≥ `SHUTDOWN_GRACE_MS`.
**Doable via Coolify API:** trigger deploy, poll deploy status.

## .dockerignore (repo root, new)

```
.git
.gitignore
node_modules
**/node_modules
.env
.env.*
!.env.example
**/dist
.planning
**/*.test.ts
**/*.spec.ts
**/__tests__
**/coverage
**/.vitest
*.md
!packages/db/migrations/**
```

> Exclude `**/dist` from the build context (it's rebuilt in-image); exclude `.env`/`node_modules`/`.git`/`.planning` for a lean, secret-free context. Keep `packages/db/migrations` (needed at runtime). [CITED: bun docker guide recommends `.dockerignore` excluding node_modules + .git]

## .env.example completeness (D-07)

Enumerated from `worker/main.ts` (defaults), `worker/env.ts` + `api/middleware/auth.ts` (fail-fast required), `db/scripts/migrate.ts` (DATABASE_URL). Current file has only `DATABASE_URL=`.

```dotenv
# Copy to .env and fill real values. NEVER commit .env. Secrets live in Coolify env (Phase 6).

# ── Required (fail-fast at startup) ──
DATABASE_URL=                 # postgres connection string (Coolify-internal host). api + worker + migrate.
ANTHROPIC_API_KEY=            # worker only. Never commit a real key.
GEO_API_KEYS=                 # api only. token:consumer_id pairs, comma-separated. e.g. tok_abc:hyperoptimized,tok_xyz:ottolax

# ── API tunables ──
PORT=8080                     # api Bun.serve port (default 8080)

# ── Worker tunables (all optional, defaults shown) ──
WORKER_CONCURRENCY=3
POLL_INTERVAL_MS=1000
LEASE_TTL_SECONDS=120
RECLAIM_INTERVAL_MS=          # default = floor(LEASE_TTL_SECONDS/2)*1000
MAX_ATTEMPTS=3
SCORING_TIMEOUT_MS=60000
SHUTDOWN_GRACE_MS=30000       # Coolify stop grace MUST be >= this for clean drain (D-09)
SCORING_MODEL=claude-sonnet-4-6
WORKER_HEARTBEAT_FILE=/tmp/worker-heartbeat   # liveness heartbeat (D-06)

# ── Mentioned in CONTEXT D-07 but verify in code before documenting ──
# DEDUP_TTL=                  # CONTEXT lists this; not found in worker/main.ts — confirm source (open question Q5)
```

> **Q5:** CONTEXT D-07 lists `DEDUP_TTL` as an env tunable but it is NOT read in `worker/main.ts` [VERIFIED: not present]. Grep the full tree before documenting it (may live in the API dedup layer from Phase 5). Don't document a var the code doesn't read.

## Deploy-verify smoke (D-08)

One-shot script (`scripts/deploy-verify.sh`, bash; or a `bun` equivalent). Bearer token = one `GEO_API_KEYS` token. Probe sequence + expected codes:

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="${GEO_API_BASE:?set GEO_API_BASE}"          # e.g. https://geo-api.titaniumlabs.us
TOKEN="${GEO_API_TOKEN:?set a GEO_API_KEYS bearer token}"
URL_TO_AUDIT="${AUDIT_URL:-https://example.com}"

# 1. poll /healthz until 200 (backoff, ~60s budget)
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz") || true
  [ "$code" = "200" ] && break
  echo "healthz=$code (try $i)"; sleep 2
done
[ "$code" = "200" ] || { echo "healthz never 200"; exit 1; }

# 2. unauth probes — docs surfaces reachable (rule 21). Expect 200.
curl -fsS -o /dev/null "$BASE/openapi.json"
curl -fsS -o /dev/null "$BASE/docs"

# 3. authed POST /audit -> {job_id}
job_id=$(curl -fsS -X POST "$BASE/audit" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"url\":\"$URL_TO_AUDIT\"}" | bun -e 'process.stdin.json?.(); ' 2>/dev/null \
  || curl -fsS -X POST "$BASE/audit" -H "Authorization: Bearer $TOKEN" \
       -H 'content-type: application/json' -d "{\"url\":\"$URL_TO_AUDIT\"}" | grep -oE '"job_id"[^,]*' )
echo "submitted: $job_id"

# 4. poll GET /audit/{id} until done|failed (~2min budget)
for i in $(seq 1 60); do
  body=$(curl -fsS "$BASE/audit/$JOB_ID" -H "Authorization: Bearer $TOKEN")
  echo "$body" | grep -q '"status":"done"'   && { echo "DONE: $body"; exit 0; }
  echo "$body" | grep -q '"status":"failed"' && { echo "FAILED: $body"; exit 1; }
  sleep 2
done
echo "audit did not finish in budget"; exit 1
```

| Probe | Expected | Meaning |
|-------|----------|---------|
| `GET /healthz` | 200 `{db:"ok"}` (503 if DB down) | API up + DB reachable |
| `GET /openapi.json`, `/docs` | 200 | rule-21 docs reachable, route mounted |
| `POST /audit` (no auth) | 401 | bearer enforced |
| `POST /audit` (bearer) | 2xx `{job_id}` | enqueue works |
| `GET /audit/{id}` | 200, status → `done` w/ numeric score + findings | worker round-trip (success criterion #2) |

> Confirm exact response field names (`job_id` vs `jobId`, `status` values, score path) against Phase 5 route schemas before finalizing the script (open question Q6 — read `packages/api/src/routes/audit.ts`).

## Common Pitfalls

### Pitfall 1: pglite leaks into the runtime image
**What:** `bun install --frozen-lockfile` installs devDeps incl. `@electric-sql/pglite` (native, test-only). **Avoid:** prune with `bun install --production --frozen-lockfile` in the **runtime stage only**. Verify post-build: `ls node_modules/@electric-sql` should be absent.

### Pitfall 2: workspace:* resolution broken in runtime
**What:** Copying only one package's `dist/` breaks `workspace:*` symlinks. **Avoid:** D-04 — copy the whole `packages/` tree + re-run `bun install --production` so symlinks resolve. Verify: `bun packages/api/dist/main.js` imports `@geo/db` without MODULE_NOT_FOUND.

### Pitfall 3: SIGTERM swallowed / 10s stop grace too short
**What:** Default Docker stop timeout is 10s; worker drain budget is 30s (`SHUTDOWN_GRACE_MS`) → in-flight audits killed → relies on lease/reclaim (works, but noisy). **Avoid:** raise Coolify stop grace ≥ `SHUTDOWN_GRACE_MS`; use `--init`/`tini` so SIGTERM forwards + zombies reaped.

### Pitfall 4: `--production` before build
**What:** Pruning dev deps before `tsup` runs removes the builder. **Avoid:** full install in `deps`/`build`, prune only in `runtime`.

### Pitfall 5: migration race on multi-replica start
**What:** If migrations run on boot across N replicas, they race. **Avoid:** D-05 one-shot pre-deploy is single-run; even the boot fallback is safe via `pg_advisory_lock` — the lock serializes, losers no-op. Already handled [VERIFIED: migrate.ts].

### Pitfall 6: build context bloat
**What:** `.planning/`, `node_modules`, `.git`, existing `dist/` inflate the context + slow builds. **Avoid:** `.dockerignore` above.

### Pitfall 7: HEALTHCHECK applies to all roles
**What:** A Dockerfile HEALTHCHECK is image-global → the heartbeat check would fail on the API (no heartbeat file written by API). **Avoid:** no global Dockerfile HEALTHCHECK; set health per Coolify resource (HTTP for API, exec/heartbeat or restart-on-exit for worker).

### Pitfall 8: migrate run from dist
**What:** `migrate.ts` is a script, not a tsup `entry` → no `dist/main.js` for it. **Avoid:** run the TS source `bun packages/db/scripts/migrate.ts` (Bun runs TS directly); ensure `packages/db/src/` is present in runtime (it is, full tree copy).

## Runtime State Inventory

This is a greenfield containerization phase (no rename/refactor). New artifacts only:
- **Stored data:** None new — uses existing Coolify Postgres + `schema_migrations`. None to migrate.
- **Live service config:** Coolify resources (2 apps + Postgres) — operator-provisioned (Human Gate), not in git.
- **OS-registered state:** None.
- **Secrets/env vars:** `DATABASE_URL`, `ANTHROPIC_API_KEY`, `GEO_API_KEYS` enter Coolify env (new), never committed. `.env.example` documents names only.
- **Build artifacts:** Docker image built by Coolify; in-image `dist/` rebuilt each deploy.

## Environment Availability

| Dependency | Required By | Available | Notes |
|------------|------------|-----------|-------|
| Docker build (Coolify host) | image build | ✓ (Coolify server 46.224.61.233) | operator-managed |
| `oven/bun:1.3.1-slim` | base image | ✓ (Docker Hub) | pin; verify tag at plan time |
| Coolify Postgres | DATABASE_URL | provision this phase | one per app (rule 17) |
| Anthropic API | worker scoring | ✓ (key via Coolify env) | — |
| `bun` locally (for verify-script dev) | building verify script | ✓ | — |

**Blocking, no fallback:** Coolify app + Postgres provisioning (operator Human Gate). **With fallback:** migrations — pre-deploy command (preferred) → boot-time guarded run.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.8 [VERIFIED: package.json] |
| Quick run | `bun run --filter '*' test` |
| Phase-6 specific | Dockerfile/deploy artifacts are validated by **build + live smoke**, not unit tests |

### Phase Requirements → Validation
| Req | Behavior | Validation | Automated |
|-----|----------|-----------|-----------|
| DEPLOY-01 | one image, API\|worker by command | `docker build` succeeds; `bun packages/api/dist/main.js` & worker entry start | local `docker build .` + run |
| DEPLOY-03 | migrations on deploy, secrets from env | pre-deploy `bun packages/db/scripts/migrate.ts` applies; no secret in image | `docker history` greps clean |
| DEPLOY-04 | live healthz + audit round-trip | `scripts/deploy-verify.sh` against live URL | post-deploy script |
| success #4 | redeploy loses no jobs | drain + lease/reclaim; SIGTERM grace | verify Coolify grace ≥ SHUTDOWN_GRACE_MS |

### Wave 0 Gaps
- [ ] `Dockerfile` (root) — new
- [ ] `.dockerignore` (root) — new
- [ ] `.env.example` — expand to full var list
- [ ] `scripts/deploy-verify.sh` — new
- [ ] worker heartbeat write (`worker.ts` minimal edit) + healthcheck script
- [ ] Coolify runbook doc (`docs/deploy.md`)

## Security Domain

| ASVS | Applies | Control |
|------|---------|---------|
| V6 Cryptography / secrets | yes | Secrets only via Coolify env; `.dockerignore` excludes `.env`; `docker history`/`docker inspect` must show no secret. Error messages name vars, never echo values [VERIFIED: env.ts]. |
| V5 Input validation | inherited | Phase 5 zod/bearer; verify script uses authed POST only |
| V1 Architecture | yes | Non-root `bun` USER in runtime; minimal slim base; no `--privileged` |

| Threat | STRIDE | Mitigation |
|--------|--------|------------|
| Secret baked into image layer | Information disclosure | env-only injection; `.dockerignore .env`; verify with `docker history --no-trunc` |
| Unauth audit submission | Elevation | bearer `GEO_API_KEYS` (Phase 5); verify 401 on no-auth POST |
| Migration tampering | Tampering | `exec()` only on committed reviewed SQL; advisory lock [VERIFIED: migrate.ts] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `oven/bun:1.3.1-slim` is current stable | Standard Stack | Pin a stale/newer patch — re-check at plan time (low risk) |
| A2 | Coolify exposes per-resource start-command override + per-resource health command | Coolify specifics | If only docker-compose works, switch to compose build pack (Q1/Q2) |
| A3 | Coolify stop-grace is configurable ≥ 30s | Pitfall 3 / D-09 | If fixed-10s, worker abandons in-flight; lease/reclaim recovers (degraded, not broken) |
| A4 | `--init`/tini is the right PID-1 fix | Signal handling | Worker already handles SIGTERM; init mainly for zombie reaping |

## Open Questions

1. **Q1 — Coolify two-resource vs docker-compose** for two services off one repo. Recommendation: try two Application resources (matches the operator's standing "one Dockerfile, two services, command selects role" pattern); fall back to compose build pack. Confirm in Coolify UI / with operator.
2. **Q2 — Per-resource non-HTTP health command** for the worker (heartbeat exec). If Coolify can't set an exec health per resource, use restart-on-exit (D-06 accepts) and skip the Dockerfile HEALTHCHECK.
3. **Q3 — `--init` per resource** in Coolify. If unavailable, bake `tini` ENTRYPOINT.
4. **Q4 — Stop-grace config** ≥ `SHUTDOWN_GRACE_MS`. Operator to confirm (Human Gate #4).
5. **Q5 — `DEDUP_TTL`** listed in CONTEXT D-07 but not read in `worker/main.ts`. Grep tree before documenting in `.env.example`.
6. **Q6 — Audit route field names** (`job_id`/`status`/score path) — read `packages/api/src/routes/audit.ts` to finalize the verify script.

## Sources

### Primary (HIGH)
- Codebase [VERIFIED]: `package.json` (root + 5 packages), `tsup.config.ts` (api/worker), `packages/api/src/main.ts`, `packages/worker/src/main.ts`, `packages/worker/src/worker.ts`, `packages/worker/src/env.ts`, `packages/api/src/middleware/auth.ts`, `packages/db/src/migrate.ts`, `packages/db/scripts/migrate.ts`, `.env.example`, `06-CONTEXT.md`.
- [Bun Docker guide](https://bun.com/docs/guides/ecosystem/docker) — multi-stage, `--frozen-lockfile`, non-root `bun` user, `.dockerignore`.
- [Coolify Dockerfile build pack](https://coolify.io/docs/builds/packs/dockerfile) + [Coolify health checks](https://coolify.io/docs/knowledge-base/health-checks) — pre/post-deploy `sh -c` commands, Dockerfile HEALTHCHECK precedence, custom start command override.
- [oven/bun Docker Hub tags](https://hub.docker.com/r/oven/bun/tags) — 1.3.1-slim current stable.

### Secondary (MEDIUM)
- [tini](https://github.com/krallin/tini) — PID-1 signal forwarding + zombie reaping.
- [Coolify applications docs](https://coolify.io/docs/applications) — custom start command override.

## Metadata

**Confidence breakdown:**
- Dockerfile / build: HIGH — verified tsup outputs, package layout, Bun docs.
- Run commands / migrations: HIGH — verified bin paths + migrate script.
- Coolify resource/health/init specifics: MEDIUM — docs confirm capabilities; exact UI wiring is operator/Human-Gate (Q1–Q4).
- Verify script field names: MEDIUM — pending audit route read (Q6).

**Research date:** 2026-06-04
**Valid until:** ~2026-07-04 (Bun base tag is the fastest-moving item; re-pin at plan time).
