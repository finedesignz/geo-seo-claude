# Phase 6: Containerize & Coolify Deploy - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-04
**Phase:** 6-Containerize & Coolify Deploy
**Mode:** --auto (autonomous; recommended option auto-selected per gray area; no AskUserQuestion)
**Areas discussed:** Dockerfile strategy, Migration execution, Worker liveness, Secrets/12-factor, Deploy & verify, Redeploy job-safety

---

## Dockerfile strategy (DEPLOY-01)

| Option | Description | Selected |
|--------|-------------|----------|
| One multi-stage Dockerfile, role by command | Single image builds whole workspace; API vs worker via start-command override; 2 Coolify services | ✓ |
| Two separate Dockerfiles/images | Independent API + worker images | |
| Single image + entrypoint branch script | One image, shell entrypoint dispatches on a MODE env | |

**Auto-selected:** One multi-stage Dockerfile, role by command (recommended; ground-truth pattern).
**Notes:** Pin `oven/bun` base version, `bun install --frozen-lockfile`, multi-stage deps→build→slim runtime (D-01..D-04).

---

## Migration execution (DEPLOY-03 / DATA-04)

| Option | Description | Selected |
|--------|-------------|----------|
| One-shot pre-deploy command | Run advisory-locked `runMigrations` via the same image before app start | ✓ |
| Guarded run on API startup | Idempotent boot-time run (advisory lock handles races) | |
| Manual operator run | Operator runs migrate by hand | |

**Auto-selected:** One-shot pre-deploy command (recommended); boot-time guarded run is the documented fallback.
**Notes:** Reuses `packages/db/scripts/migrate.ts` — `pg_advisory_lock(6473656073656)` + `schema_migrations` idempotency (D-05).

---

## Worker liveness (DEPLOY-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Heartbeat file + health command | Worker touches `/tmp/worker-heartbeat` each loop; Coolify checks freshness | ✓ |
| Process monitor only | Rely on Coolify restart-on-exit (worker `process.exit(1)` on fatal) | |
| Add an HTTP health port to worker | New minimal HTTP server in worker | |

**Auto-selected:** Heartbeat file (recommended — catches a hung-but-alive loop that process-monitor misses) (D-06).
**Notes:** No HTTP probe for worker (no port). Minimal worker change: touch heartbeat in poll loop.

---

## Secrets / 12-factor (DEPLOY-03)

| Option | Description | Selected |
|--------|-------------|----------|
| All secrets+tunables from Coolify env; expand .env.example | Nothing baked into image/repo; fail-fast at startup (already implemented) | ✓ |
| Bake non-secret config into image | Hardcode tunables, env only for secrets | |

**Auto-selected:** All from env; expand `.env.example` (recommended) (D-07).
**Notes:** Required: DATABASE_URL, ANTHROPIC_API_KEY, GEO_API_KEYS. Optional tunables already env-driven. `.dockerignore` excludes `.env`.

---

## Deploy & verify (DEPLOY-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Deploy live now + verify round-trip | Deploy to Coolify, poll /healthz, real POST /audit→poll GET /audit/{id} | ✓ |
| Produce deploy-ready artifacts + runbook only | No live deploy this phase | |

**Auto-selected:** Deploy live + verify (recommended; ROADMAP success criterion #2 + DEPLOY-04 + rule 14) (D-08).
**Notes:** One-shot verify script (also probe /openapi.json + /docs). Completes deferred Phase 5 live verifications.

---

## Redeploy job-safety (ROADMAP success criterion #4)

| Option | Description | Selected |
|--------|-------------|----------|
| Rely on existing durable queue + lease/reclaim + graceful drain | Verify only; no new code | ✓ |
| Add new drain/handoff mechanism | Build extra shutdown coordination | |

**Auto-selected:** Rely on existing mechanism + verify (recommended) (D-09).
**Notes:** Jobs in Postgres (not memory); SKIP LOCKED + lease-reclaim recover dead-worker jobs; SIGTERM graceful drain (SHUTDOWN_GRACE_MS). Confirm Coolify stop grace ≥ SHUTDOWN_GRACE_MS.

---

## Claude's Discretion

- Exact Bun base image patch version (pin at plan time).
- Migration trigger mechanism (pre-deploy command vs boot-guard fallback) per Coolify capability.
- Heartbeat file path + interval thresholds.

## Deferred Ideas

- Cron re-audit container (DEPLOY-02 logic) — Phase 7.
- Consumer wiring (CONS-01/02) — Phase 7.
- CI/CD pipeline + image registry promotion + staging/prod split — out of v1 scope.
- Runtime image trimming to single-service dependency closure — optimization deferred.
