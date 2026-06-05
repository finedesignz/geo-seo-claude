# Phase 6: Containerize & Coolify Deploy - Context

**Gathered:** 2026-06-04 (auto-mode, YOLO defaults)
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase makes the already-built API (`@geo/api`) and worker (`@geo/worker`) **shippable and shipped** on Coolify as a container image, with all secrets injected from env, verified live.

**In scope:**
- A single multi-stage `Dockerfile` at repo root that builds the whole Bun workspace monorepo once and produces a lean runtime image runnable as EITHER the API service OR the worker — selected by container command/entrypoint, not by separate images.
- `.dockerignore` (keep build context lean; never copy `.env`, `node_modules`, `.git`).
- Migration execution strategy on deploy (reuse the existing advisory-locked `runMigrations` runner — `packages/db/src/migrate.ts` via `packages/db/scripts/migrate.ts`).
- Worker liveness/process monitoring (worker has no HTTP port).
- `.env.example` expanded to document every required/optional runtime var (12-factor); nothing secret committed or baked into the image.
- A documented Coolify deploy runbook: two services (API + worker) off the SAME image, env wiring, health-check config, redeploy semantics.
- Live deploy-verify: poll `/healthz` until 200, then a real `POST /audit` → poll `GET /audit/{id}` round-trip (ROADMAP success criterion #2 / DEPLOY-04).

**Out of scope (deferred to Phase 7):**
- The **cron container** re-audit scheduler (DEPLOY-02 cron *logic* lands in Phase 7; this phase only proves the image/command pattern that the cron service will reuse).
- Consumer wiring (`hyperoptimizedwebsites` inline import, `ottolax` HTTP) — CONS-01/CONS-02, Phase 7.
- CI/CD pipeline build automation, image registry promotion flows, multi-env (staging/prod) split — not required by v1 ROADMAP.
- Titanium auth (explicitly scoped out; bearer `GEO_API_KEYS` stays — Phase 5 D-03).

**Requirements:** DEPLOY-01, DEPLOY-02 (partial — image/command pattern only), DEPLOY-03, DEPLOY-04.

</domain>

<decisions>
## Implementation Decisions

### Dockerfile strategy (DEPLOY-01)
- **D-01:** **Single multi-stage Dockerfile at repo root**, ONE image, run target (API vs worker) chosen by the container start command. Stages: (1) `deps` — `bun install --frozen-lockfile` over the workspace (copy root `package.json` + `bun.lock` + all `packages/*/package.json` first for layer caching); (2) `build` — copy sources, run the per-package `tsup` builds (`bun run build` across workspaces) so each package emits `dist/`; (3) `runtime` — slim `oven/bun` image with only what the chosen service needs (built `dist/` + production `node_modules` + `packages/db/migrations`). Rationale: ground-truth recommendation; both services share the monorepo, one build artifact, less drift, smaller surface. (recommended; DEPLOY-01)
- **D-02:** **Pin the Bun base image to an explicit version tag** (e.g. `oven/bun:1.x.y-slim` — planner/researcher confirms the current stable tag at plan time; do NOT use `latest`). Reproducible + lean. Use `--frozen-lockfile` for deterministic installs against the committed `bun.lock`. (recommended; reproducibility)
- **D-03:** **Run target selected by command, default = API.** The image's default `CMD` starts the API (`bun packages/api/src/main.ts` / its built `dist/main.js` Bun.serve entry, honoring `PORT`, default 8080). The worker Coolify service overrides the start command to run the worker entry (`bun .../worker dist/main.js`). No `ENTRYPOINT` branching script needed — Coolify per-service "start command" override is the switch. (recommended; DEPLOY-01)
- **D-04:** **Build all workspace packages in the image** (`@geo/core`, `@geo/fetch`, `@geo/db`, `@geo/api`, `@geo/worker`) because of `workspace:*` deps; the runtime stage keeps the full resolved `node_modules` + every package `dist/` (simplest correct option for a Bun workspace; trimming to a single service's transitive closure is a deferred optimization, not worth the risk for MVP). (Claude's discretion)

### Migration execution (DEPLOY-03 / DATA-04)
- **D-05:** **Run migrations as a one-shot pre-deploy / release step**, not silently on every API boot. Reuse the existing advisory-locked idempotent runner: `packages/db/scripts/migrate.ts` (`bun scripts/migrate.ts` → `runMigrations`, `pg_advisory_lock(6473656073656)` guards concurrent runners; `schema_migrations` table makes it idempotent). The SAME image runs the migrate command (override start command to the migrate script) as a Coolify pre-deploy command or a one-shot run. Rationale: idempotent + advisory-locked so it's *safe* either way, but a one-shot keeps API/worker startup fast and decoupled and avoids N concurrent boot-time runners racing (the lock handles races, but explicit is clearer). If Coolify pre-deploy hooks prove awkward, the documented fallback is a guarded idempotent run on API startup (still safe via the advisory lock + migrations ledger). (recommended; DEPLOY-03)

### Worker liveness (DEPLOY-01)
- **D-06:** **No HTTP probe for the worker** — it has no port. Use a **liveness heartbeat file** the worker `touch`es each poll-loop iteration (e.g. `/tmp/worker-heartbeat`), checked by a Coolify container health command (`test $(( $(date +%s) - $(stat -c %Y /tmp/worker-heartbeat) )) -lt <2×POLL_INTERVAL>`), OR rely on Coolify's process-monitor (restart-on-exit) since the worker `process.exit(1)`s on fatal error (see `packages/worker/src/main.ts`). Recommended: heartbeat-file health check (detects a hung-but-alive loop, which process-monitor misses). Minimal worker change: write/touch the heartbeat in the loop. (recommended; DEPLOY-01)

### Secrets / 12-factor (DEPLOY-03)
- **D-07:** **All secrets + tunables from Coolify env**, nothing baked into image or repo. Required (fail-fast at startup, already implemented): `DATABASE_URL`, `ANTHROPIC_API_KEY` (worker), `GEO_API_KEYS` (api). Optional tunables with defaults (already env-driven in `worker/main.ts`): `PORT`, `WORKER_CONCURRENCY`, `POLL_INTERVAL_MS`, `LEASE_TTL_SECONDS`, `RECLAIM_INTERVAL_MS`, `MAX_ATTEMPTS`, `SCORING_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `SCORING_MODEL`, `DEDUP_TTL`. **Expand `.env.example`** (currently only `DATABASE_URL=`) to document ALL of these with safe placeholder/empty values + comments. `.dockerignore` MUST exclude `.env`. (recommended; DEPLOY-03)

### Deploy & verify (DEPLOY-04)
- **D-08:** **Deploy live in this phase, then verify** (do not stop at "deploy-ready artifacts"). Acceptance smoke (the ROADMAP success criterion + DEPLOY-04 + the deferred Phase 5 live verifications): after Coolify deploy, (1) poll `GET /healthz` until `200 {db:"ok"}`; (2) `POST /audit` with a real bearer token + a real public URL → `{job_id}`; (3) poll `GET /audit/{job_id}` until `done` with numeric `score` + `findings`. Bundle as a one-shot script the verifier runs post-deploy (global rule 14 — never claim shipped on `/healthz` alone; also probe `/openapi.json` + `/docs` reachable). (recommended; DEPLOY-04, ROADMAP success criterion #2)
- **D-09:** **Redeploy must not lose in-flight/queued jobs** (ROADMAP success criterion #4). This is already satisfied by the Phase 3/4 durable Postgres queue + lease/reclaim: jobs live in Postgres (not in-memory), and the worker's `SELECT FOR UPDATE SKIP LOCKED` + lease-reclaim sweep recovers any job whose worker died mid-run. The worker's graceful drain (`SHUTDOWN_GRACE_MS`, SIGTERM handling in `worker/main.ts`) lets Coolify stop it cleanly. Plan: confirm Coolify sends SIGTERM + respects a stop grace ≥ `SHUTDOWN_GRACE_MS`; no new code expected, only verification. (recommended; ROADMAP success criterion #4)

### Claude's Discretion
- Exact Bun base image patch version (pin at plan time to current stable).
- Whether migrations run as a Coolify "pre-deploy command" vs a one-shot manual run vs guarded API-boot fallback — all three are safe; planner picks per Coolify capability. Default: pre-deploy command.
- Heartbeat-file path + interval thresholds for the worker health check.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project / requirements
- `.planning/ROADMAP.md` — Phase 6 goal + 4 success criteria (single image API|worker by flag; live `/healthz` + audit round-trip; no secret in image/committed file; redeploy loses no jobs).
- `.planning/REQUIREMENTS.md` §Deploy / Operations — DEPLOY-01..04 (and DEPLOY-02 cron deferred to Phase 7).
- `.planning/PROJECT.md` — constraints (Coolify Postgres, Bun monorepo, internal service, Titanium out).
- `.planning/phases/05-bun-hono-api-layer/05-CONTEXT.md` — D-03 bearer `GEO_API_KEYS` auth + `/healthz`/`/openapi.json`/`/docs` public-exemption decision; deferred live verifications this phase completes.

### Service entrypoints (containerize these)
- `packages/api/src/main.ts` — Bun.serve API entry; `PORT` (default 8080), fail-fast `GEO_API_KEYS` via `parseApiKeys`, lazy DAL/fetcher. Comment already says "Phase 6 containerizes this."
- `packages/worker/src/main.ts` — worker bin entry; `assertEnv()` first (DATABASE_URL + ANTHROPIC_API_KEY), all tunables via env, `maxRetries:0` Anthropic client, graceful drain, `process.exit(1)` on fatal.
- `packages/api/src/routes/healthz.ts` — deep `SELECT 1` health route (200/503) Coolify health check targets.
- `packages/api/src/env.ts` / `packages/worker/src/env.ts` — fail-fast env guards (never echo values).

### Migrations
- `packages/db/src/migrate.ts` — `runMigrations(db)`: advisory-locked (`pg_advisory_lock(6473656073656)`), idempotent via `schema_migrations`. `listApplied`.
- `packages/db/scripts/migrate.ts` — CLI entry (`bun scripts/migrate.ts` / `... status`); package scripts `migrate` + `migrate:status`.
- `packages/db/migrations/0001_create_audits.sql`, `packages/db/migrations/0002_add_consumer_id.sql` — applied in container against Coolify Postgres.

### Build / docs
- `package.json` (root) + `packages/*/package.json` — Bun workspace; each package `build: tsup`. `bun.lock` for `--frozen-lockfile`.
- `packages/api/scripts/gen-docs.ts` + `packages/api/docs/api.md` — rule-21 OpenAPI artifact; container must keep `/openapi.json` + `/docs` reachable.
- `.env.example` — to be expanded this phase (currently only `DATABASE_URL=`).
- `C:\Users\artic\GitHub\_templates\bun-hono-app\` — bootstrap/reference for Bun+Hono Dockerfile + docs conventions (rule 21).

### Stack / infra rules
- `~/.claude/CLAUDE.md` rule 14 — phase completion: docs + version + release + Coolify deploy verify (poll `/healthz` then smoke real `/api/*` routes, not `/health` alone).
- `~/.claude/CLAUDE.md` rule 17 — Postgres on Coolify, one per app, `DATABASE_URL` in Coolify env never in repo.
- `~/.claude/CLAUDE.md` rule 21 — `/openapi.json` + `/docs` + `docs/` per app; must stay reachable in container.
- `~/.claude/infrastructure.md` + `~/.claude/secrets/services.json` — Coolify `https://coolify.titaniumlabs.us` (server 46.224.61.233), API token + deploy webhook; port map (pick 9100–9199 if a host port is needed).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Advisory-locked migration runner** (`packages/db/src/migrate.ts` `runMigrations` + `packages/db/scripts/migrate.ts`): safe to run as a one-shot or guarded boot step; no new migration machinery needed.
- **API Bun.serve entry** (`packages/api/src/main.ts`): already env-driven (`PORT`, `GEO_API_KEYS`), lazy DAL so import doesn't throw without DB — container-ready.
- **Worker entry** (`packages/worker/src/main.ts`): all tunables already env-driven; `assertEnv()` fail-fast; SIGTERM graceful drain (`SHUTDOWN_GRACE_MS`) — supports clean Coolify stop for zero-job-loss redeploy.
- **Deep `/healthz`** (`packages/api/src/routes/healthz.ts`): public, returns 200/503 on DB reachability — exactly what a Coolify HTTP health check needs.
- **Durable Postgres queue** (Phase 3/4): jobs persist + lease/reclaim → redeploy safety (success criterion #4) already structurally satisfied.

### Established Patterns
- **Fail-fast env at startup**, error messages name the var but never echo its value (both `env.ts` files). Container must surface these clearly in logs.
- **Per-package `tsup` build → `dist/`** with `bin` entries (`geo-api`, `geo-worker`). Multi-stage build runs these.
- **Lazy resolution of DAL/fetcher** so module import is side-effect-free — image build doesn't need DB access.

### Integration Points
- **No Dockerfile / .dockerignore exists yet** — both are new in this phase (repo root).
- **`.env.example` is minimal** (`DATABASE_URL=` only) — expand to full 12-factor var list (D-07).
- **Coolify**: two services off one image (API + worker) + Postgres; env secrets set in Coolify UI; health check → `/healthz`; redeploy via Coolify deploy webhook/API.

</code_context>

<specifics>
## Specific Ideas

- "One multi-stage Dockerfile, two Coolify services, command selects the role" — the operator's standing containerization pattern for shared-monorepo services.
- Deploy-verify smoke MUST be a real audit round-trip against the live URL (not `/health` alone) per rule 14 — bundle into a one-shot script for the verifier.

</specifics>

<deferred>
## Deferred Ideas

- **Cron re-audit container (DEPLOY-02 logic)** — Phase 7. This phase only establishes the image+command pattern the cron service reuses.
- **Consumer wiring** (`hyperoptimizedwebsites` inline `@geo/core`, `ottolax` Python HTTP) — CONS-01/02, Phase 7.
- **CI/CD build pipeline + image registry promotion + staging/prod split** — out of v1 scope.
- **Runtime image trimming to a single service's transitive dependency closure** — optimization deferred; MVP keeps full resolved `node_modules`.

</deferred>

---

## ⚠ Human Gate (operator action — surface to orchestrator)

The following require operator action in the **Coolify UI / API** (creds in `~/.claude/secrets/services.json`; the orchestrator may do these via the Coolify API where possible, but provisioning + secret entry is operator-owned):

1. **Provision a new Coolify app + Postgres** for `geo-api` (one Postgres per app, rule 17). Capture the app UUID + Postgres `DATABASE_URL` (Coolify-internal hostname).
2. **Set env secrets in Coolify** for both services: `DATABASE_URL`, `ANTHROPIC_API_KEY` (worker), `GEO_API_KEYS` (api), plus any non-default tunables. Never committed.
3. **Configure two services off one image** (API + worker) with per-service start-command override, and point the API service health check at `/healthz`.
4. Confirm Coolify stop grace ≥ `SHUTDOWN_GRACE_MS` so the worker drains cleanly on redeploy (success criterion #4).

Decisions above assume these will be done; planner/executor produce all artifacts (Dockerfile, .dockerignore, expanded .env.example, deploy runbook, verify script) so the only remaining work is the UI provisioning + the live verify.

---

*Phase: 6-Containerize & Coolify Deploy*
*Context gathered: 2026-06-04 (auto-mode)*
