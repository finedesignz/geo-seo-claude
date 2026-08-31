---
phase: 06-containerize-coolify-deploy
plan: 02
subsystem: deploy
tags: [coolify, smoke-test, runbook, bash, ops]
requires: [06-01]
provides:
  - "Env-driven live smoke script: healthz poll → openapi/docs probes → unauth 401 → authed audit round-trip"
  - "Coolify deploy runbook: provision, two-resource-off-one-image, per-resource health, pre-deploy migrate, stop-grace, post-deploy verify"
affects: []
tech-stack:
  added: []
  patterns: [env-only secrets, bun JSON.parse with grep/sed fallback, operator-vs-API split, advisory-locked idempotent migrate]
key-files:
  created: [scripts/deploy-verify.sh, docs/deploy.md]
  modified: []
decisions:
  - "Smoke script reads GEO_API_BASE/GEO_API_TOKEN/AUDIT_URL from env — no hardcoded token or URL (T-06-05)"
  - "Runbook splits [HUMAN GATE] (Coolify UI) vs [AUTOMATABLE] (Coolify API); UUIDs/secrets left as placeholders for plan 03 / Phase 7"
  - "One image, three run targets (API default CMD, worker override, migrate override) — role by start-command"
metrics:
  duration: ~12 min
  completed: 2026-06-04
requirements: [DEPLOY-03, DEPLOY-04]
---

# Phase 6 Plan 02: Deploy Tooling + Runbook Summary

Authored the live-deploy artifacts plan 03 consumes — a self-contained env-driven smoke
script (`scripts/deploy-verify.sh`) and a complete operator runbook (`docs/deploy.md`) —
both written without a live Coolify resource so the phase is not blocked on the human gate.

## What was built

- **scripts/deploy-verify.sh** (D-08, DEPLOY-04): `#!/usr/bin/env bash`, `set -euo pipefail`.
  Reads `GEO_API_BASE` + `GEO_API_TOKEN` (required, fails fast if unset) and `AUDIT_URL`
  (default `https://example.com`). Sequence: (1) poll `/healthz` 30×2s until 200 + asserts
  `db:ok`; (2) `GET /openapi.json` 200 with `"openapi"` key + `GET /docs` 200 (rule 21);
  (3) unauth `POST /audit` → asserts 401 (T-06-06); (4) authed `POST /audit` → parse
  `job_id`; (5) poll `GET /audit/{job_id}` 60×2s → exit 0 on `done` (prints body), exit 1
  on `failed`/timeout. `job_id`/`status` extracted via `bun -e` JSON.parse with a grep/sed
  fallback. Header comment marks it as verifier-run AFTER the live deploy, not CI.
- **docs/deploy.md** (D-05/D-07/D-09, rule 21): one-image/three-run-target overview; a
  **Human Gate** section (provision app + one Postgres per rule 17; per-resource env
  secrets table from `.env.example`; two Application resources off the same image with API
  HTTP `/healthz` health + worker exec `scripts/worker-healthcheck.sh`; worker stop grace
  ≥ `SHUTDOWN_GRACE_MS`); **Migrations** (API Pre-deployment command
  `bun packages/db/scripts/migrate.ts`, advisory-locked/idempotent + boot-time fallback);
  **PID-1/signals** (`--init` else tini); **Automatable** Coolify API redeploy
  (`POST /api/v1/deploy?uuid=<app-uuid>`, token in `~/.claude/secrets/services.json`);
  **Verify** step running the smoke script; **Redeploy safety** (durable Postgres jobs +
  SIGTERM drain). Operator vs automatable clearly split; UUIDs/secrets are placeholders.

## Interface confirmation (against source)

Field names cross-checked against `packages/api/src/routes/audit-post.ts` (`{job_id}` on
200; 401 without bearer) and `healthz.ts` (200 `{status:ok,db:ok}` / 503). Migrate command
confirmed at `packages/db/scripts/migrate.ts`.

## Validations run

- `bash -n scripts/deploy-verify.sh` → OK.
- Token/section greps: `GEO_API_TOKEN`, `/healthz`, `/openapi.json`, `job_id` present.
- No-hardcoded-token grep gate (`Bearer [A-Za-z0-9_]{8,}` outside comments) → none.
- shellcheck absent in env → `bash -n` only (parity with plan 01).
- Runbook section keywords all present (`start command`, `Pre-deployment`, `healthz`,
  `worker-healthcheck`, `SHUTDOWN_GRACE_MS`, `deploy-verify`, `api/v1/deploy`, `Human Gate`).

## Deviations from Plan

None — plan executed as written.

## Self-Check: PASSED

- scripts/deploy-verify.sh, docs/deploy.md exist.
- Commits: 4fcee3a (deploy-verify.sh), 74c6f62 (docs/deploy.md).
