---
phase: 07-cron-consumer-wiring
plan: 01
subsystem: cron
tags: [cron, deploy, http-client, fail-fast, in-process-test]
requires:
  - "@geo/api createApp (in-process test target)"
  - "@geo/db PGlite harness (makeTestDal)"
  - "@geo/fetch createSafeFetcher"
provides:
  - "@geo/cron one-shot scheduled re-audit caller (runCron + env fail-fast)"
  - "DEPLOY-02 code + unit tests (live firing DEFERRED-LIVE)"
affects:
  - "packages/cron (new workspace package)"
tech-stack:
  added: []
  patterns:
    - "injectable fetchImpl seam (default global fetch) → tests pass app.request, zero network"
    - "continue-on-failure loop with accumulated CronSummary → exit code reflects partial failure"
    - "env fail-fast mirroring @geo/worker assertEnv; token named but never echoed"
key-files:
  created:
    - packages/cron/package.json
    - packages/cron/tsup.config.ts
    - packages/cron/tsconfig.json
    - packages/cron/vitest.config.ts
    - packages/cron/src/index.ts
    - packages/cron/src/env.ts
    - packages/cron/src/cron.ts
    - packages/cron/src/main.ts
    - packages/cron/src/__tests__/env.test.ts
    - packages/cron/src/__tests__/cron.test.ts
  modified:
    - bun.lock
decisions:
  - "CRON_TARGET_URLS parsed comma OR newline (split /[\\n,]/), trimmed, empties dropped, each validated with new URL() + http(s) protocol check before any POST (D-2)"
  - "runCron returns CronSummary {total,succeeded,failed,results[]} (richer than the research's CronResult[]) so main.ts derives the exit code without re-filtering"
  - "main.ts exit semantics: exit 1 iff any URL failed, else 0 (Coolify marks task failed on non-zero)"
  - "cron test imports createApp/parseApiKeys via relative ../../../api/src path (NOT the @geo/api barrel — createApp is not exported there), mirroring pglite-helper's @geo/db relative import"
  - "tsconfig mirrors @geo/api (excludes src/__tests__) so tsup DTS build does not pull test-only relative cross-package imports"
metrics:
  duration: ~20 min
  completed: 2026-06-04
---

# Phase 7 Plan 01: @geo/cron Package + Re-audit Caller Summary

One-liner: dependency-light one-shot `@geo/cron` that POSTs `/audit` per configured URL with a Bearer token, continues on per-URL failure, and exits with a code reflecting partial failure — proven in-process against real `@geo/api` + PGlite (DEPLOY-02 code-complete; live firing DEFERRED-LIVE).

## What Was Built

- **`packages/cron` workspace package** mirroring `@geo/worker`: tsup dual ESM+CJS → `dist/main.js`, vitest, strict tsconfig, `bin: geo-cron`. **Zero runtime `dependencies`** (D-8); `@geo/api`/`@geo/db`/`@geo/fetch`/`@electric-sql/pglite` are test-only devDeps.
- **`src/env.ts`** — `assertEnv()` fail-fast on missing `CRON_TARGET_URLS`/`CRON_API_TOKEN`/`GEO_API_BASE_URL` (names the var, never echoes a token), strips a trailing slash from the base URL (Pitfall 6). `parseTargetUrls()` splits comma/newline, trims, drops empties, validates each with `new URL()` + http(s) protocol, throws naming the bad value or on empty list.
- **`src/cron.ts`** — pure `runCron({baseUrl,token,urls,fetchImpl})`: POST `${baseUrl}/audit` per URL with `authorization: Bearer ${token}` + JSON `{url}`; non-ok → `http_<status>` and continue; thrown error → captured and continue; returns `CronSummary`. The Authorization header value is never logged (T-07-01 / Pitfall 5).
- **`src/main.ts`** — one-shot: `assertEnv` → `parseTargetUrls` → `runCron(global fetch)` → redacted summary line → `process.exit(failed>0?1:0)`.
- **`src/index.ts`** — barrel exporting `assertEnv`, `parseTargetUrls`, `runCron` + types.
- **Tests** — `env.test.ts` (12 cases: parse comma/newline/trim/empty/invalid/non-http + assertEnv required/strip/no-echo), `cron.test.ts` (4 cases: per-URL POST with jobs scoped to consumer `cron` via real PGlite DAL, partial-failure isolation on a 400-rejected URL, 401 yields `http_401` with no inserts, thrown-fetch isolation). No DAL mock; in-process `app.request` as `fetchImpl`.

## Verification Results

- `bun run --cwd packages/cron test -- --run` → **16/16 green** (2 files).
- Full ordered build (core→fetch→db→api→worker→cron) → all success; `packages/cron/dist/main.js` emitted.
- Regression spot-check: `@geo/api` 40/40, `@geo/worker` 38/38 — no regressions (shared types untouched).
- `packages/cron/package.json` runtime `dependencies: {}` (D-8 satisfied).
- No Authorization header / token value in any `console.log`/`console.error` argument (cron.ts logs url+job_id/status only; main.ts logs counts only).

## Deviations from Plan

### Auto-fixed / discretionary

**1. [Discretionary] runCron returns `CronSummary` object, not `CronResult[]`**
- The plan's RESEARCH Pattern 1 sketched `Promise<CronResult[]>`; the plan body also referenced a `{total,succeeded,failed,results[]}` summary in the critical constraints. Implemented the richer `CronSummary` so `main.ts` reads `summary.failed` directly. `CronResult` gained `ok`/`status` fields for precise assertions. No behavioral change; matches the constraints section.

**2. [Discretionary] cron test imports `createApp` via relative path, not `@geo/api` barrel**
- `createApp` is not re-exported from the `@geo/api` package barrel (confirmed by reading `packages/api/src/index` usage in api tests, which import from `../app.js`). Used `../../../api/src/app.js` + `../../../api/src/middleware/auth.js` + `../../../api/src/__tests__/pglite-helper.js`, exactly the relative-cross-package pattern `pglite-helper.ts` uses for `@geo/db`. Added `exclude: ["src/__tests__/**"]` to `tsconfig.json` (mirroring api) so the tsup DTS build never tries to resolve those test-only relative imports.

## Deferred / Out of Scope (this plan)

- **Live scheduled firing (DEPLOY-02 live)** — Coolify scheduled task off the deployed image; DEFERRED-LIVE (Phase 6 operator gate unmet).
- **Wave 2 (plan 07-02)** — Coolify scheduled-task run-target wiring, `.env.example` CRON_*/GEO_API_KEYS entries, `docs/deploy.md` cron section + cadence-vs-dedup warning, Dockerfile `COPY packages/cron/package.json`, plus the CONS-01 (`examples/how-inline-usage.ts`) and CONS-02 (`examples/ottolax-client.py` + `docs/consumers.md`) consumer artifacts.

## Threat Flags

None — no new network endpoint, auth path, or schema surface introduced. The cron process only POSTs to OUR api over the existing bearer-auth path; it never fetches the target URLs itself (no SSRF surface added — T-07-02). All `<threat_model>` mitigations (T-07-01 token-not-logged, T-07-02 URL-validate, T-07-04 continue-on-failure) are implemented.

## Self-Check: PASSED

- Created files present: packages/cron/{package.json,tsup.config.ts,tsconfig.json,vitest.config.ts}, src/{index,env,cron,main}.ts, src/__tests__/{env,cron}.test.ts — all FOUND.
- Commits FOUND: 7d7ba2f (Task 1), aaf076b (Task 2).
