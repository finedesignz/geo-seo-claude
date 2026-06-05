---
phase: 06-containerize-coolify-deploy
verified: 2026-06-04T20:20:00Z
status: human_needed
score: 7/7 must-haves verified (3/4 roadmap SC PASS, 1 DEFERRED-LIVE behind human gate)
verdict: SHIP WITH NOTES
re_verification: No — initial verification
human_verification:
  - test: "Operator provisions Coolify app + Postgres, enters secrets, deploys both resources, runs scripts/deploy-verify.sh against the live API origin"
    expected: "deploy-verify.sh exits 0: /healthz 200 db:ok → /openapi.json + /docs 200 → unauth POST /audit 401 → authed POST /audit returns job_id → GET /audit/{id} reaches done"
    why_human: "No Coolify app/Postgres provisioned; deploy branch unpushed (third-party origin, needs auth); secrets absent. Standing up prod infra + live Anthropic key is operator-owned/irreversible. Documented DEFERRED-LIVE gate (DEPLOY-RECORD.md), becomes Phase-7 precondition."
  - test: "Confirm worker container stop grace >= SHUTDOWN_GRACE_MS (30s) and a redeploy mid-audit loses no queued/in-flight jobs"
    expected: "Worker drains in-flight on SIGTERM within grace; any unfinished job keeps its row and is reclaimed by next worker after lease expiry — no data loss (roadmap SC #4)"
    why_human: "Requires a live Coolify resource to set stop-grace UI field and exercise a real redeploy"
deferred:
  - truth: "Coolify service starts, passes live /healthz, completes real POST /audit round-trip (roadmap SC #2)"
    addressed_in: "Phase 7 (live deploy = Phase-7 precondition per DEPLOY-RECORD.md / 06-03-PLAN gate-deferred)"
    evidence: "DEPLOY-04 mapped to Phase 7 live acceptance; DEPLOY-02 cron explicitly Phase 7 in REQUIREMENTS.md:137"
---

# Phase 6: Containerize & Coolify Deploy — Verification Report

**Phase Goal:** API + worker ship as a container image deployed on Coolify with all secrets from env, verified by a live /healthz + audit round-trip.
**Verified:** 2026-06-04
**Status:** human_needed (live deploy gated)
**Verdict:** SHIP WITH NOTES — all containerization + deploy-readiness + verify tooling PASS; the live round-trip is a legitimate operator-gated DEFERRED-LIVE item, not a gap.

## Roadmap Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `docker build` → single image, run API or worker mode via env/command flag | ✓ PASS | `Dockerfile:16-66` multi-stage deps→build→runtime; default `CMD ["bun","packages/api/dist/main.js"]`; worker/migrate by start-cmd override (`docs/deploy.md:18-24`). No entrypoint branch script. |
| 2 | Coolify service starts, passes live /healthz, real POST /audit round-trip | ⏸ DEFERRED-LIVE | Tooling complete (`scripts/deploy-verify.sh`); no live URL. Operator gate per `DEPLOY-RECORD.md`. healthz route returns 200 `{db:ok}` / 503 `{db:error}` (`healthz.ts:16,48,50`). |
| 3 | No secret in image or any committed file | ✓ PASS | `.dockerignore:5-7` excludes `.env`/`.env.*`, keeps `!.env.example`; `.git`, `.planning`, `node_modules`, `dist`, tests excluded. `git ls-files`: no `.env` tracked. Secret scan: only fake `user:pass@localhost` test fixtures. `.env.example` has names, no values. |
| 4 | Redeploy does not lose in-flight/queued jobs | ⏸ DEFERRED-LIVE (design PASS) | Jobs durable in Postgres (lease+reclaim, Phase 3/4); worker SIGTERM drain ≤ SHUTDOWN_GRACE_MS; `docs/deploy.md:141-147` requires stop grace ≥ grace. Live redeploy proof gated. |

## Requirements Coverage

| Req | Description | Status | Evidence |
|-----|-------------|--------|----------|
| DEPLOY-01 | Image ships API + worker as separate Coolify services | ✓ PASS | One image, two resources off same image (`docs/deploy.md:60-70`); role by start-cmd. |
| DEPLOY-03 | Secrets from Coolify env, none baked | ✓ PASS | `.dockerignore` + `.env.example` (names only) + per-resource env table (`docs/deploy.md:42-58`). |
| DEPLOY-04 | Verify via /healthz + real /audit round-trip (not /health alone) | ⏸ DEFERRED-LIVE | `scripts/deploy-verify.sh` exercises full round-trip; live run = operator step 8. |
| DEPLOY-02 | Cron re-audit container | ⏸ DEFERRED | Explicitly Phase 7 (`REQUIREMENTS.md:137`). Out of Phase 6 scope. |

## Artifact Verification (exists / substantive / wired / data-flow)

| Artifact | Status | Detail |
|----------|--------|--------|
| `Dockerfile` | ✓ VERIFIED | Pinned `oven/bun:1.3.1-slim` (not :latest); `bun install --frozen-lockfile`; runtime `--production` prune; `USER bun` non-root; exec-form CMD = API PID-1; STOPSIGNAL SIGTERM; tini fallback documented; build stage NEVER prunes. |
| `.dockerignore` | ✓ VERIFIED | Secret-free context; keeps `migrations/**` (runtime reads .sql); keeps `.env.example`. |
| `.env.example` | ✓ VERIFIED | Enumerates exactly the vars read: DATABASE_URL, ANTHROPIC_API_KEY, GEO_API_KEYS, PORT, SCORING_MODEL, WORKER_HEARTBEAT_FILE + worker tunables. No stray DEDUP (hardcoded const `audit-post.ts:29`). No values. |
| `scripts/worker-healthcheck.sh` | ✓ VERIFIED | `bash -n` clean; exits 1 on missing/stale heartbeat (mtime age ≥ MAX_AGE_S). |
| `scripts/deploy-verify.sh` | ✓ VERIFIED | `bash -n` clean; healthz poll → openapi/docs → 401 → authed POST job_id → poll to done/failed. Token from env (preflight die if unset); NO hardcoded bearer. Field names match (job_id, status enum done/failed/queued/running, healthz 200). |
| `docs/deploy.md` | ✓ VERIFIED | Rule-21 runbook: HUMAN GATE vs AUTOMATABLE, two-resources-off-one-image, migration one-shot, stop grace ≥ SHUTDOWN_GRACE_MS, PID-1 guidance, post-deploy verify. Placeholders only. |
| `DEPLOY-RECORD.md` | ✓ VERIFIED | Honest DEFERRED-LIVE; readiness table, ordered operator checklist, deferred-verification list, no fabricated transcript/UUIDs. |
| `packages/worker/src/worker.ts` heartbeat | ✓ VERIFIED | `writeFileSync(heartbeatFile, Date.now())` each poll iteration (`worker.ts:52,76`); non-fatal on IO error. |

## Dependency Prune Correctness

| Pkg | Dep type | Status |
|-----|----------|--------|
| `postgres` (@geo/db) | dependency | ✓ kept by `--production` |
| `@electric-sql/pglite` (@geo/db) | devDependency | ✓ pruned (test-only) |
| `hono`, `@hono/zod-openapi`, `@scalar/hono-api-reference`, `zod` (@geo/api) | dependency | ✓ kept (/docs + /openapi.json served in-code) |
| `tsup`, `typescript`, `vitest` | devDependency | ✓ pruned (build-only, never in build stage) |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Worker tests green (heartbeat additive) | `bun run --cwd packages/worker test -- --run` | 38 passed (5 files) | ✓ PASS |
| worker-healthcheck.sh syntax | `bash -n` | clean | ✓ PASS |
| deploy-verify.sh syntax | `bash -n` | clean | ✓ PASS |
| No tracked secrets | `git ls-files` + secret regex | only fake test fixtures (`user:pass@localhost`) | ✓ PASS |
| Env var ↔ .env.example parity | grep api+worker src vs template | exact match; no missing/stray | ✓ PASS |

## Anti-Patterns Found

None blocking. `docker build` not run locally (no Docker in env; first build on Coolify) — documented, acceptable. Base tag `oven/bun:1.3.1-slim` not pull-verified in-env — note in DEPLOY-RECORD to confirm on first Coolify build.

## Gaps Summary

No actionable gaps within Phase 6 scope. The phase deliverable — containerization, deploy-readiness, and verify tooling — is complete and correct. The live `/healthz` + audit round-trip (roadmap SC #2, #4; DEPLOY-04) is a legitimately operator-gated DEFERRED-LIVE item: no Coolify app/Postgres provisioned, deploy branch unpushed (third-party origin), secrets absent. It is documented (DEPLOY-RECORD.md) and becomes a Phase-7 precondition. This is DEFERRED, not MISSING — the phase is not failed for it.

**Verdict: SHIP WITH NOTES.** All artifacts PASS; the only open item is the documented human-gated live deploy.

---

_Verified: 2026-06-04T20:20:00Z_
_Verifier: Claude (gsd-verifier)_
