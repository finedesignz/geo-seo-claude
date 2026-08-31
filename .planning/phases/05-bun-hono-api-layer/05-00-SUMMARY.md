---
phase: 05-bun-hono-api-layer
plan: 00
subsystem: api-prereqs
tags: [db-migration, consumer-scoping, ssrf-post, api-scaffold, zod-v3]
requires:
  - "@geo/db DAL (insertJob/getJob/listJobs/findRecentByUrlHash)"
  - "@geo/fetch resolve-then-pin validator (resolveAndValidate, validateUrl)"
  - "@geo/db PGlite harness (Phase 3)"
provides:
  - "audits.consumer_id column + consumer-scoped DAL (D-11)"
  - "@geo/fetch validateUrlHost + createSafeRequester SSRF-safe POST (D-12)"
  - "@geo/api package scaffold with createApp factory + /openapi.json + /docs (D-01/D-14)"
affects:
  - packages/db
  - packages/fetch
  - packages/api
tech-stack:
  added:
    - "@hono/zod-openapi@0.19.10 (zod v3 peer)"
    - "@scalar/hono-api-reference@0.10.20"
    - "hono@4.12.23"
    - "zod@3.25.51 (workspace-aligned)"
  patterns:
    - "consumer_id = $consumer equality scoping (legacy null rows excluded)"
    - "reuse exported validateUrl for SSRF POST (no duplication)"
    - "createApp({dal,fetcher}) DI factory — no module-level singleton DAL"
key-files:
  created:
    - packages/db/migrations/0002_add_consumer_id.sql
    - packages/fetch/src/safe-requester.ts
    - packages/fetch/src/__tests__/safe-requester.test.ts
    - packages/api/package.json
    - packages/api/tsconfig.json
    - packages/api/tsup.config.ts
    - packages/api/vitest.config.ts
    - packages/api/.env.example
    - packages/api/src/index.ts
    - packages/api/src/app.ts
    - packages/api/src/main.ts
    - packages/api/src/__tests__/pglite-helper.ts
    - packages/api/src/__tests__/scaffold.test.ts
  modified:
    - packages/db/src/types.ts
    - packages/db/src/dal.ts
    - packages/db/src/__tests__/queue.test.ts
    - packages/db/src/__tests__/migrate.test.ts
    - packages/fetch/src/safe-fetcher.ts
    - packages/fetch/src/index.ts
decisions:
  - "@hono/zod-openapi@0.19.10 chosen: peer zod >=3.0.0; transitive @asteasolutions/zod-to-openapi@7 peers zod ^3.20.2 (strictly v3). Workspace zod stays 3.25.51."
  - "validateUrl exported from safe-fetcher.ts and reused by safe-requester.ts (no duplicated validator)."
  - "undici request() defaults to 0 auto-redirections; maxRedirections option absent from this undici version's type — relied on default + explicit 3xx→REDIRECT_BLOCKED."
  - "api tsconfig excludes src/__tests__ so tsup DTS rootDir holds (helper imports @geo/db source cross-package)."
metrics:
  duration: ~25 min
  completed: 2026-06-05
  tasks: 3
  files: 19
---

# Phase 5 Plan 00: Wave 0 Prerequisites Summary

Additive cross-package prerequisites for the API layer: consumer-scoped `@geo/db` DAL (migration 0002), SSRF-safe POST + submit-time host validator in `@geo/fetch`, and a building `@geo/api` Bun+Hono scaffold on zod v3 — all three suites green, no existing behavior changed.

## What Was Built

### Task 1 — @geo/db consumer scoping (D-11) — commit f32d0d7
- Migration `0002_add_consumer_id.sql`: `ADD COLUMN IF NOT EXISTS consumer_id text` + partial index `idx_audits_consumer_id (consumer_id, created_at DESC) WHERE consumer_id IS NOT NULL`. Additive, nullable, idempotent.
- `types.ts`: `consumerId?: string` on `InsertJobInput`/`PaginationInput`; `consumerId: string | null` on `AuditJob`.
- `dal.ts`: `insertJob` persists `consumer_id` (5th param); `listJobs` uses `WHERE ($3::text IS NULL OR consumer_id = $3)` (back-compat when omitted); `findRecentByUrlHash(urlHash, ttlMs, consumerId)` adds `AND consumer_id = $3` **equality** — legacy null rows and other consumers never match. `rowToJob` surfaces `consumerId`. All parameterised `$N`.
- Tests: consumer-scope suite (insert/get/list/dedup) + updated existing dedup tests to pass a consumer; updated `migrate.test.ts` migration-list assertions.

### Task 2 — @geo/fetch SSRF-safe POST (D-12) — commit d6b3a42
- Exported internal `validateUrl` from `safe-fetcher.ts` for reuse (no duplication).
- `safe-requester.ts`:
  - `validateUrlHost(url, opts?)` — DNS resolve + IP classify, **no HTTP request** (D-08); returns `{ ok, code? }`.
  - `createSafeRequester(opts?)` — re-validates per attempt (TOCTOU), POSTs to pinned IP with TLS `servername`; never follows redirects (3xx → `REDIRECT_BLOCKED`); response-size cap; bounded timeout + retries with backoff; never throws (returns `buildErrorResult`).
- Barrel exports `createSafeRequester`, `validateUrlHost`, `SafeRequesterOptions`, `SafeRequestInput`, `HostValidationResult`.
- Tests use mock resolver + undici `MockAgent`: public host allowed, loopback/RFC1918/metadata blocked with no connect, redirect-into-host blocked.

### Task 3 — @geo/api scaffold (D-01/D-14) — commit c38193d
- `@geo/api` package mirroring `@geo/db` conventions (tsup dual ESM/CJS, vitest, `bin: geo-api`).
- Deps: `@hono/zod-openapi@0.19.10`, `@scalar/hono-api-reference@0.10.20`, `hono@4.12.23`, `zod@3.25.51`, workspace `@geo/db|fetch|core`.
- `createApp({dal,fetcher})` factory → `OpenAPIHono` with a registered `/healthz` route (non-empty registry), `app.doc31('/openapi.json', {openapi:'3.1.0'})`, Scalar at `/docs`.
- `main.ts` Bun.serve entry with lazy DAL resolution (no throw on import without DATABASE_URL). `.env.example` documents `GEO_API_KEYS`/`DATABASE_URL`/`PORT`.
- `pglite-helper.ts` reuses `@geo/db` harness + executor + migration runner; `makeTestDal()` runs real migrations on in-memory PGlite.
- `scaffold.test.ts`: `/openapi.json` parseable OpenAPI 3.1 with ≥1 path; `/docs` 200.

## Dependency Version Resolution (D-14)

| Package | Chosen | zod peer |
|---------|--------|----------|
| @hono/zod-openapi | 0.19.10 | `zod >=3.0.0` (transitive @asteasolutions/zod-to-openapi@7 → `zod ^3.20.2`, strictly v3) |
| @scalar/hono-api-reference | 0.10.20 | `hono ^4.12.5` (no zod peer) |
| hono | 4.12.23 | — |
| zod | 3.25.51 | matches worker/scorer workspace pin |

Workspace/api zod resolves to **3.25.51** (verified in `bun.lock`). A nested `zod@4.4.3` exists only under `@scalar/types` (Scalar's isolated internal type dep) — it does not affect our request/response schemas or the generated OpenAPI spec. No zod v4 pulled into `@geo/api`.

## Deviations from Plan

**1. [Rule 3 - Blocking] `maxRedirections` option not in undici type**
- Found during: Task 2 DTS build.
- Issue: undici `request()` options type in this version rejects `maxRedirections`.
- Fix: removed the option; undici `request()` defaults to 0 auto-redirections (same as GET path), and an explicit 3xx is mapped to `REDIRECT_BLOCKED`. No-follow behavior preserved.
- Commit: d6b3a42.

**2. [Rule 3 - Blocking] api DTS build picked up deprecated `baseUrl` from an ancestor tsconfig**
- Found during: Task 3 build (no local api tsconfig existed).
- Fix: added `packages/api/tsconfig.json` mirroring `@geo/db` (`ignoreDeprecations: "6.0"`), with `exclude: ["src/__tests__/**"]` so DTS `rootDir` holds while the cross-package test helper still resolves under vitest.
- Commit: c38193d.

**3. [Rule 3 - Blocking] existing tests assumed old signatures**
- `migrate.test.ts` hardcoded the migration list; updated to include `0002_add_consumer_id`.
- `queue.test.ts` `findRecentByUrlHash` calls now pass a consumer (and insert with one) since dedup is consumer-scoped equality.
- Commit: f32d0d7.

## Threat Model Coverage

- T-05-W0-01 (SQL tampering): all DAL extensions use `$N` placeholders, no string concat. ✓
- T-05-W0-02 (SSRF POST): reuses `resolveAndValidate` (all A+AAAA); blocked IP never connects; never throws. ✓
- T-05-W0-03 (history scoping): `listJobs` equality scoping; Wave 2 always passes a consumerId. ✓
- T-05-W0-SC (npm installs): packages from owner bootstrap template, all VERIFIED on registry; no blocking checkpoint. ✓

No secrets committed (`.env.example` only).

## Verification

- `bun run --cwd packages/db test -- --run` → 55 passed, 1 skipped.
- `bun run --cwd packages/fetch test -- --run` → 116 passed, 7 todo; `build` green.
- `bun run --cwd packages/api test -- --run` → 2 passed; `build` green (ESM+CJS+DTS).

## Known Stubs

`createApp` registers only `/healthz` as a scaffold placeholder — submit/poll/history routes + bearer auth middleware are Wave 1/2 (intentional, documented in plan). No data-rendering stubs.

## Self-Check: PASSED
