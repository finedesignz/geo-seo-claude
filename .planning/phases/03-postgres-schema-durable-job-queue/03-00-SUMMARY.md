---
phase: 03-postgres-schema-durable-job-queue
plan: "00"
subsystem: "@geo/db"
tags: [db, postgres, pglite, testing, scaffold]
dependency_graph:
  requires: []
  provides: ["@geo/db workspace package", "postgres.js getSql()", "PGlite test harness"]
  affects: ["03-01-PLAN.md (migration runner)", "03-02-PLAN.md (typed DAL)"]
tech_stack:
  added: ["postgres@3.4.9", "@electric-sql/pglite@0.5.1"]
  patterns: ["lazy singleton with fail-fast guard", "ephemeral in-process Postgres per test file"]
key_files:
  created:
    - packages/db/package.json
    - packages/db/tsconfig.json
    - packages/db/tsup.config.ts
    - packages/db/vitest.config.ts
    - packages/db/src/index.ts
    - packages/db/src/client.ts
    - packages/db/src/__tests__/client.test.ts
    - packages/db/src/__tests__/harness.ts
    - packages/db/src/__tests__/harness.test.ts
    - .env.example
  modified:
    - .gitignore (added !.env.example exception)
    - bun.lock (new workspace deps)
decisions:
  - "getSql() is a lazy factory (not module-top-level) so test files that import but never call getSql() do not throw on import"
  - "_resetSqlForTests() internal helper resets memo between unit tests without dynamic import churn"
  - "describeIfRealDb gated by both DATABASE_URL AND ALLOW_DB_TESTS=1 to prevent accidental real-DB runs"
  - "assertTestDatabaseUrl() rejects DB names without test/testing/dev to prevent prod-DB test pollution"
  - "migrations/ added to package.json files array now so plan-01 migration files are included in published artifacts without a follow-up packaging change"
metrics:
  duration: "~15 min"
  completed: "2026-06-02"
  tasks: 3
  files: 11
---

# Phase 3 Plan 00: @geo/db Scaffold Summary

**One-liner:** postgres.js lazy getSql() with DATABASE_URL fail-fast guard + PGlite ephemeral in-process Postgres test harness, no Docker required.

## What Was Built

- `packages/db` workspace package (`@geo/db`) mirroring `@geo/fetch` conventions: dual ESM/CJS tsup build, strict TS 6.0.3, vitest.
- `src/client.ts`: `getSql()` lazy singleton — reads `process.env.DATABASE_URL`, throws `Error("@geo/db: DATABASE_URL is required but not set …")` if unset (DATA-03). Error message names the variable but never echoes its value (T-03-LEAK). postgres.js `tagged-template` API used exclusively (T-03-INJ). `_resetSqlForTests()` helper for unit isolation.
- `src/__tests__/client.test.ts`: 3 unit tests (no real DB). Guard throw, guard non-throw, no-value-in-error.
- `src/__tests__/harness.ts`: `makePgliteDb()` factory returning `{ exec, query, close }` backed by `new PGlite()` — ephemeral, no data dir. `hasRealDb()` + `describeIfRealDb` + `assertTestDatabaseUrl()` for optional real-Postgres tests.
- `src/__tests__/harness.test.ts`: SELECT 1 smoke, DB-isolation check, guard unit tests. All pass with no Docker.
- `.env.example`: `DATABASE_URL=` placeholder only.
- `.gitignore`: added `!.env.example` exception (`.env.*` pattern previously matched `.env.example`).

## Verification Results

```
bun run --cwd packages/db build   → ESM + CJS + DTS emitted, clean
bun run --cwd packages/db test    → 8/8 passed (client.test.ts 3, harness.test.ts 5)
bun run --cwd packages/core test  → 106/106 passed (unaffected)
bun run --cwd packages/fetch test → 107/107 passed (unaffected)
git grep DATABASE_URL= -- ':!*.example' → only plan/doc files, no real values
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] .gitignore `.env.*` pattern rejected .env.example**
- **Found during:** Task 2 git add
- **Issue:** Existing `.env.*` glob in `.gitignore` caused `git add .env.example` to fail.
- **Fix:** Added `!.env.example` negation line immediately after the `.env.*` pattern.
- **Files modified:** `.gitignore`
- **Commit:** included in `feat(03-00)` commit

## Known Stubs

None — scaffold only. `src/index.ts` exports `{}` intentionally; plans 01 and 02 populate the public surface.

## Threat Flags

None. No new network endpoints, auth paths, or trust-boundary surface introduced. All threat mitigations (T-03-LEAK, T-03-INJ, T-03-SC) implemented as planned.

## Self-Check: PASSED

- packages/db/src/client.ts — FOUND
- packages/db/src/__tests__/harness.ts — FOUND
- .env.example — FOUND
- Commits c5fc81b, 969d94e, 8b05db3 — verified in git log
