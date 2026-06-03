---
phase: 03-postgres-schema-durable-job-queue
verified: 2026-06-02T17:22:00Z
status: human_needed
score: 4/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Run true-concurrency SKIP LOCKED test against live Coolify Postgres"
    expected: "Two concurrent claimNextJob() calls via Promise.all return DIFFERENT row ids — zero double-claims"
    why_human: "PGlite is single-connection; cannot prove multi-session SKIP LOCKED semantics without a real multi-connection Postgres server. Requires TEST_DATABASE_URL + ALLOW_DB_TESTS=1 pointed at Coolify. Deferred to Phase 6 DEPLOY-04 per VALIDATION.md contract."
---

# Phase 3: Postgres Schema & Durable Job Queue — Verification Report

**Phase Goal:** Audit jobs and results are durably stored in Coolify Postgres with a versioned schema and a correct SKIP LOCKED job queue that survives service restarts.
**Verified:** 2026-06-02T17:22:00Z
**Status:** HUMAN_NEEDED (one proof deferred to real Postgres in Phase 6)
**Re-verification:** No — initial verification

---

## Gate Commands Run

```
bun run --cwd packages/db test -- --run
  → 7 files, 48 passed, 1 skipped  ✓

bun run --cwd packages/db build
  → ESM + CJS + DTS clean, no errors  ✓
```

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Fresh-migrate produces audits table with all required columns | ✓ VERIFIED | `0001_create_audits.sql` — all 17 D-06 columns present; `schema.test.ts` validates each column type via PGlite |
| 2 | Job inserted as `queued` is claimable and transitions queued→running→done\|failed | ✓ VERIFIED | `lifecycle.test.ts` + `queue.test.ts` — full lifecycle exercised under PGlite; `claimNextJob` returns row with `leaseToken` UUID |
| 3 | Killing/restarting service does not strand jobs in `running` (lease/timeout detection) | ✓ VERIFIED (partial) | `reclaimExpired()` in `dal.ts:325–340` flips expired-lease rows back to `queued`, max-attempts guard → `failed`; proven via PGlite in `queue.test.ts`. Actual restart-survival needs a persistent server (Phase 6 live test) |
| 4 | `DATABASE_URL` never in any committed file; read from env only | ✓ VERIFIED | `client.ts:26–30` — fail-fast assert throws if env absent; `.env.example` has placeholder only; grep across repo found zero committed connection strings |
| 5 | True concurrent SKIP LOCKED — two claimers get different rows | ? UNCERTAIN | `concurrency.test.ts` is gated behind `TEST_DATABASE_URL + ALLOW_DB_TESTS=1`; skipped with logged reason. Structural check in `queue.test.ts:246–265` asserts `FOR UPDATE SKIP LOCKED` is present inside a `sql.begin()` block (source-text assertion), but this is a code-structure proof, not a runtime concurrency proof |

**Score:** 4/5 truths verified (1 deferred by design)

---

## Requirement Coverage

### DATA-01 — Audits schema: all D-06 columns present

**PASS**

`packages/db/migrations/0001_create_audits.sql` (lines 15–36):

All 17 columns confirmed present:
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `url text NOT NULL`, `normalized_url text NOT NULL`, `url_hash text NOT NULL`
- `status text NOT NULL DEFAULT 'queued'` with CHECK constraint `IN ('queued','running','done','failed')`
- `score int` with CHECK `(score IS NULL OR (score >= 0 AND score <= 100))`
- `findings jsonb`, `error_code text`, `callback_url text`
- `attempts int NOT NULL DEFAULT 0`
- `locked_at timestamptz`, `lease_expires_at timestamptz`, **`lease_token uuid`** (D-06 fencing token)
- `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`
- `started_at timestamptz`, `finished_at timestamptz`

Indexes (dal.ts D-07):
- `idx_audits_queued ON (created_at, id) WHERE status='queued'` — partial index on claim path ✓
- `idx_audits_running_expired ON (lease_expires_at) WHERE status='running'` — reclaim path ✓
- `idx_audits_url_hash ON (url_hash)` — dedup ✓

`updated_at` trigger `audits_updated_at` installed ✓

`schema.test.ts` validates all column types against live PGlite — 48 tests green.

---

### DATA-02 — Durable state machine; survives restart

**PASS (with Phase 6 live caveat)**

State machine `queued → running → done | failed` is persisted in Postgres SQL — not in-memory. All transitions implemented in `dal.ts`:
- `insertJob` → status='queued'
- `claimNextJob` → status='running', `lease_token=gen_random_uuid()`, `attempts++`
- `completeJob` → status='done', clears lease columns
- `failJob` → status='failed', clears lease columns
- `reclaimExpired` → expired-lease `running` rows → back to `queued` (or `failed` at max attempts)

All exercised via PGlite in `lifecycle.test.ts` and `queue.test.ts`.

Actual multi-process restart survival is a Phase 6 concern (needs persistent server); the SQL logic proves state is durable by nature of being in Postgres.

---

### DATA-03 — `DATABASE_URL` env-only, never committed

**PASS**

- `packages/db/src/client.ts:19–34` — `assertDatabaseUrl()` throws `Error` with message directing to `.env.example` if env is absent
- `.env.example` line 3: `DATABASE_URL=` (placeholder, no value)
- `grep -r "DATABASE_URL=postgres"` across entire repo → **zero matches**
- `.gitignore` at root excludes `.env`

---

### DATA-04 — Versioned SQL migrations + advisory-locked runner + `schema_migrations` table; repeatable on fresh DB

**PASS**

`packages/db/src/migrate.ts`:
- `schema_migrations` table created if not exists (line ~40)
- `pg_advisory_lock(ADVISORY_LOCK_KEY)` acquired before checking/applying pending migrations (line 78); caught with warning log if PGlite doesn't support it (line 83) — graceful degradation documented
- Each migration applied in a transaction; version recorded in `schema_migrations`
- Idempotency: already-applied migrations skipped by checking `schema_migrations`
- Re-run on fresh DB: proven by `migrate.test.ts` under PGlite

`migrations/0001_create_audits.sql` uses `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `CREATE INDEX IF NOT EXISTS` — idempotent SQL ✓

---

### WORK-01 — SKIP LOCKED claim: single-txn SELECT…FOR UPDATE SKIP LOCKED + atomic state update; reclaimExpired; lease fencing

**PARTIAL** (structural proof only; runtime concurrency proof deferred)

`packages/db/src/dal.ts`:

**claimNextJob (lines 169–210):**
```sql
-- Inside sql.begin():
-- Step A: reclaimExpired() called first
-- Step B: SELECT ... FROM audits WHERE status='queued' ORDER BY created_at, id
--         FOR UPDATE SKIP LOCKED LIMIT 1
-- Step C: UPDATE audits SET status='running', lease_token=gen_random_uuid(),
--         locked_at=now(), lease_expires_at=now()+(secs*interval), started_at=now(),
--         attempts=attempts+1 WHERE id=$1 RETURNING *
```
Single transaction confirmed — all steps inside `sql.begin()`.

**completeJob (line 214–236):**
`WHERE id=$1 AND status='running' AND lease_token=$2::uuid` — lease fencing ✓
Returns `false` on zero rows (stale token rejected) ✓

**failJob (line 239–255):**
Same `AND lease_token=$2::uuid` fence ✓

**renewLease (line 261–272):**
Same `AND lease_token=$2::uuid` fence ✓

**reclaimExpired (lines 315–340):**
`WHERE status='running' AND lease_expires_at < now()` — max-attempts guard → `failed`, else → `queued`, clears lease columns ✓

**What is NOT proven at runtime:** Two simultaneous claimers receiving different rows. `concurrency.test.ts` is correctly skipped-with-reason. `queue.test.ts:246–265` does a source-text assertion that `FOR UPDATE SKIP LOCKED` appears inside a `sql.begin()` block — this confirms code structure but not runtime semantics. Per VALIDATION.md, this is explicitly deferred to Phase 6 DEPLOY-04.

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/src/index.ts` | All DAL exports | ✓ VERIFIED | Exports: `getSql`, `runMigrations`, `listApplied`, all types, `createAuditDal`, `getDefaultDal`, `makePgExecutor` |
| `packages/db/src/dal.ts` | 9 DAL functions (D-10) | ✓ VERIFIED | `insertJob`, `claimNextJob`, `completeJob`, `failJob`, `renewLease`, `getJob`, `listJobs`, `findRecentByUrlHash`, `reclaimExpired` |
| `packages/db/src/migrate.ts` | Advisory-locked idempotent runner | ✓ VERIFIED | pg_advisory_lock + schema_migrations + per-file transactions |
| `packages/db/migrations/0001_create_audits.sql` | All D-06 columns | ✓ VERIFIED | 17 columns, CHECK constraint, 3 indexes, trigger |
| `packages/db/src/client.ts` | DATABASE_URL fail-fast guard | ✓ VERIFIED | assertDatabaseUrl() throws on missing env |
| `.env.example` | DATABASE_URL placeholder | ✓ VERIFIED | Placeholder only, no real value |
| `packages/db/src/__tests__/concurrency.test.ts` | Gated, skipped-with-reason | ✓ VERIFIED | describeIfRealDb + console.log skip reason + deferral to Phase 6 DEPLOY-04 |
| `packages/db/dist/` | ESM + CJS + DTS build | ✓ VERIFIED | tsup clean, all three artifacts produced |

---

## Anti-Patterns

None found. No TBD/FIXME/XXX markers, no stub implementations, no hardcoded empty returns in production code paths.

The advisory lock has a documented graceful-degradation path (PGlite compatibility) — this is intentional and noted, not a bug.

---

## Human Verification Required

### 1. True SKIP LOCKED Concurrency Proof

**Test:** Point a real Postgres DB at `TEST_DATABASE_URL`, set `ALLOW_DB_TESTS=1`, run `bun run --cwd packages/db test -- --run`. The `concurrency.test.ts` suite should activate.

**Expected:** `Promise.all([dal.claimNextJob(), dal.claimNextJob()])` with 2 seeded rows returns two different `id` values — zero double-claims.

**Why human:** PGlite is single-connection and cannot simulate two concurrent sessions holding locks. Needs a real multi-connection Postgres. Deferred to Phase 6 DEPLOY-04 per VALIDATION.md contract and documented in 03-00-SUMMARY.md.

---

## Gaps Summary

No blocking gaps. The one deferred item (true-concurrency SKIP LOCKED proof) is intentional, documented in VALIDATION.md, and has a clear Phase 6 resolution path. The code structure proof (source-text assertion in `queue.test.ts`) confirms the claim query is structurally correct.

---

## SHIP VERDICT

**SHIP WITH NOTES**

All automated gates pass (48/49 tests green, 1 skipped-with-reason; build clean). All D-06 columns present. State machine proven via PGlite. Lease fencing on all terminal/renewal operations. DATABASE_URL never committed. Advisory-locked migration runner idempotent.

The single open item — runtime SKIP LOCKED concurrency proof — is correctly gated and deferred to Phase 6 by explicit design contract in VALIDATION.md. Phase 4 (Worker Pipeline) can safely build on this package; the structural correctness of the claim query is verified, and the concurrency guarantee will be closed at deploy time.

---

_Verified: 2026-06-02T17:22:00Z_
_Verifier: Claude (gsd-verifier) — independent, not the Phase 3 executor_
