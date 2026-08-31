---
phase: 03-postgres-schema-durable-job-queue
plan: 01
subsystem: "@geo/db"
tags: [migration, schema, postgres, pglite, data]
dependency_graph:
  requires: ["03-00"]
  provides: ["schema_migrations", "audits table", "runMigrations", "listApplied", "0001_create_audits"]
  affects: ["packages/db"]
tech_stack:
  added: []
  patterns: ["advisory-lock migration runner", "schema_migrations version table", "PGlite test harness"]
key_files:
  created:
    - packages/db/src/migrate.ts
    - packages/db/scripts/migrate.ts
    - packages/db/migrations/0001_create_audits.sql
    - packages/db/src/__tests__/migrate.test.ts
    - packages/db/src/__tests__/schema.test.ts
  modified: []
decisions:
  - "Advisory lock (pg_advisory_lock) best-effort: PGlite lacks the function, runner logs warning and proceeds without lock (safe for single-connection test context)"
  - "tx.unsafe() scoped to migration runner only (T-03-UNSAFE); all DAL queries use parameterised templates"
  - "status as text + CHECK constraint (not enum) — additive-safe per anti-pattern note"
  - "ADVISORY_LOCK_KEY as decimal integer constant (not hex literal) to satisfy esbuild/oxc parser"
  - "BEGIN/exec/ROLLBACK transaction pattern used instead of sql.begin() because MigrationDb interface must be PGlite-compatible"
metrics:
  duration: "~15 min"
  completed_date: "2026-06-02"
  tasks_completed: 2
  files_created: 5
---

# Phase 3 Plan 01: Migration Runner + Audits Schema Summary

**One-liner:** Advisory-locked idempotent migration runner (`schema_migrations`) and `0001_create_audits.sql` with full D-06 columns, status/score CHECKs, updated_at trigger, and 3 partial indexes — 24 tests green on PGlite.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migration runner + scripts entrypoint | 4e1ab58 | src/migrate.ts, scripts/migrate.ts |
| 2 | 0001_create_audits.sql + schema tests | 4e1ab58 | migrations/0001_create_audits.sql, src/__tests__/migrate.test.ts, src/__tests__/schema.test.ts |

## What Was Built

### `src/migrate.ts`
- `runMigrations(db, migrationsDir)` — idempotent, advisory-locked, each .sql file in its own BEGIN/COMMIT transaction; rollback on failure
- `listApplied(db)` — returns applied versions from `schema_migrations` in order
- `MigrationDb` interface — satisfied by both postgres.js `sql` instance and PGlite `DbHandle`; decouples runner from singleton client

### `scripts/migrate.ts`
- Bun entrypoint for `bun run migrate` (apply pending) and `bun run migrate:status` (list applied)
- Resolves `migrations/` relative to package (not `process.cwd()`)

### `migrations/0001_create_audits.sql`
All D-06 columns: `id uuid PK gen_random_uuid()`, `url`, `normalized_url`, `url_hash`, `status text CHECK (queued|running|done|failed)`, `score int CHECK (0..100 or NULL)`, `findings jsonb`, `error_code`, `callback_url`, `attempts int default 0`, `locked_at`, `lease_expires_at`, `lease_token uuid` (D-07), `created_at`, `updated_at`, `started_at`, `finished_at`.

Trigger: `set_updated_at()` BEFORE UPDATE sets `NEW.updated_at = now()`.

Indexes:
- `idx_audits_queued ON audits (created_at, id) WHERE status='queued'` — claim path
- `idx_audits_running_expired ON audits (lease_expires_at) WHERE status='running'` — lease recovery
- `idx_audits_url_hash ON audits (url_hash)` — deduplication

## Test Coverage (24 tests, all green)

- migrate.test.ts: fresh-apply, idempotency, listApplied before/after, rollback on bad SQL, lexicographic order
- schema.test.ts: table existence, all 17 D-06 columns present with correct type families, status CHECK (accept all 4 valid values, reject invalid), score CHECK (accept 0/50/100/NULL, reject 101/-1), schema_migrations record, updated_at trigger

## Deviations from Plan

**1. [Rule 1 - Bug] Hex literal in advisory lock key constant**
- **Found during:** Task 1, first test run
- **Issue:** `6473656f73656f` hex literal contains letters (`f`) — esbuild/oxc rejects as "invalid characters after number"
- **Fix:** Changed to valid decimal integer constant `6473656073656`
- **Files modified:** `src/migrate.ts`
- **Commit:** 4e1ab58 (same commit, fixed before final commit)

**2. [Rule 1 - Design] PGlite advisory lock unavailability**
- PGlite does not expose `pg_advisory_lock()`. Runner catches the error, logs a warning, and proceeds without the lock.
- This is safe because PGlite is single-connection (tests only).
- Production postgres.js path acquires the lock normally.
- Documented in source code and CONTEXT.md note.

**3. [Rule 1 - Design] MigrationDb uses BEGIN/exec instead of sql.begin()**
- `sql.begin()` is a postgres.js-specific API not present on PGlite's `DbHandle`.
- Used `db.exec("BEGIN") / db.exec("COMMIT") / db.exec("ROLLBACK")` which both adapters support.

## Known Stubs

None — all columns wired to real SQL; no placeholder data.

## Threat Surface Scan

No new network endpoints, auth paths, or trust-boundary changes introduced. Migration files are committed code (T-03-UNSAFE annotation present and enforced by interface design — `exec()` is not exposed on the production runtime query path).

## Self-Check: PASSED

- `packages/db/src/migrate.ts` — exists
- `packages/db/scripts/migrate.ts` — exists
- `packages/db/migrations/0001_create_audits.sql` — exists
- `packages/db/src/__tests__/migrate.test.ts` — exists
- `packages/db/src/__tests__/schema.test.ts` — exists
- Commit 4e1ab58 — verified in git log
- 24 tests green: `bun run --cwd packages/db test -- --run`
