---
phase: 3
slug: postgres-schema-durable-job-queue
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-02
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Environment constraint

No local Postgres, no Docker, no DATABASE_URL in this environment. Test strategy:
- **PGlite** (`@electric-sql/pglite`) — real in-process WASM Postgres — runs migrations, schema, lifecycle (queued→running→done|failed), and lease-reclaim tests with REAL SQL, no Docker. Covers DATA-01/02/04 + reclaim at runtime now.
- **True-concurrency SKIP LOCKED** (two sessions claiming, no double-claim) needs a multi-connection server → integration test is gated behind `TEST_DATABASE_URL` + `ALLOW_DB_TESTS=1` (never prod `DATABASE_URL`; reject non-test-looking DB names) and skipped-with-reason when absent. Concurrency is proven against live Coolify Postgres in Phase 6 (DEPLOY-04). The claim query's structural correctness is asserted now (single-txn SELECT…FOR UPDATE SKIP LOCKED + atomic state update).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `packages/db/vitest.config.ts` (Wave 0 installs) |
| **Quick run command** | `bun run --cwd packages/db test -- --run` |
| **Full suite command** | `bun run --cwd packages/db test -- --run` |
| **Estimated runtime** | ~10 seconds (PGlite); +concurrency only when DATABASE_URL set |

---

## Sampling Rate

- **After every task commit:** `bun run --cwd packages/db test -- --run`
- **After every plan wave:** full suite + `bun run --cwd packages/db build`
- **Before verify:** PGlite suite green; DAL types conform; migrations apply clean on a fresh PGlite db
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------------|-----------|-------------------|-------------|--------|
| 3-00-01 | 00 | 0 | infra | package + PGlite harness | infra | `bun run --cwd packages/db test -- --run` | ❌ W0 | ⬜ pending |
| 3-01-01 | 01 | 1 | DATA-04 | migration runner idempotent + schema_migrations | unit/int | `bun run --cwd packages/db test migrate` | ❌ W0 | ⬜ pending |
| 3-02-01 | 02 | 1 | DATA-01,DATA-03 | fresh-migrate yields audits table all columns; DATABASE_URL env-only | int | `bun run --cwd packages/db test schema` | ❌ W0 | ⬜ pending |
| 3-03-01 | 03 | 2 | DATA-02,WORK-01 | lifecycle queued→running→done\|failed; claim query SKIP LOCKED; reclaim expired lease | int | `bun run --cwd packages/db test queue` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/db/package.json` (`@geo/db`, deps: `postgres`, dev: `@electric-sql/pglite`, vitest)
- [ ] `packages/db/vitest.config.ts`
- [ ] PGlite test harness (fresh in-process db per test file) + optional `DATABASE_URL` real-pg harness
- [ ] `.env.example` with `DATABASE_URL=` placeholder

---

## Manual-Only / Deferred Verifications

| Behavior | Requirement | Why Deferred | When verified |
|----------|-------------|--------------|---------------|
| Two concurrent claimers get DIFFERENT rows (true SKIP LOCKED concurrency) | WORK-01 | PGlite is single-connection; needs a multi-session server | Phase 6 against live Coolify Postgres (DEPLOY-04), or now if a real DATABASE_URL is provided |
| Restart-survival of job state | DATA-02 | Requires a persistent server + redeploy | Phase 6 live; logic proven via PGlite persistence within a run |

*All other phase behaviors have automated PGlite-backed verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
