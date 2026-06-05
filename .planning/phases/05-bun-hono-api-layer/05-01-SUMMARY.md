---
phase: 05-bun-hono-api-layer
plan: 01
subsystem: api-auth-submit
tags: [bearer-auth, ssrf-submit, consumer-dedup, openapi-route, zod-v3]
requires:
  - "@geo/api createApp factory (05-00)"
  - "@geo/db consumer-scoped DAL: insertJob/findRecentByUrlHash/getJob/listJobs (05-00)"
  - "@geo/fetch validateUrlHost (05-00)"
  - "@geo/core normalizeUrl"
provides:
  - "bearerAuth middleware + parseApiKeys fail-fast (token->consumer_id)"
  - "POST /audit OpenAPIHono route (validate->normalize->dedup->callback SSRF->insert)"
  - "AppDeps.apiKeys + AppDeps.callbackResolver injection seams"
affects:
  - packages/api
tech-stack:
  added:
    - "hono/factory createMiddleware (already in hono@4.12.23)"
  patterns:
    - "EXEMPT set (/healthz,/openapi.json,/docs) handled inside middleware so docs surface stays public"
    - "sha256+timingSafeEqual constant-time, length-safe token compare (no throw on length mismatch)"
    - "first-unescaped-colon split + backslash escaping for ','/'  :'-bearing tokens (D-03)"
    - "consumer-scoped dedup with status!=='failed' filter (D-04/D-13)"
    - "submit-time callback SSRF via validateUrlHost + injected resolver (D-08)"
key-files:
  created:
    - packages/api/src/middleware/auth.ts
    - packages/api/src/routes/audit-post.ts
    - packages/api/src/__tests__/auth.test.ts
    - packages/api/src/__tests__/audit-post.test.ts
  modified:
    - packages/api/src/app.ts
    - packages/api/src/main.ts
    - packages/api/src/index.ts
    - packages/api/src/__tests__/scaffold.test.ts
decisions:
  - "GEO_API_KEYS parse: pairs comma-separated, split on FIRST unescaped ':'; backslash escaping (\\, \\: \\\\) lets a token contain ',' or ':' (D-03)."
  - "Token compare hashes both sides to sha256 (fixed length) before timingSafeEqual — guarantees equal-length buffers so no throw, and iterates all keys (no early return) for position-independent timing."
  - "DEDUP_TTL_MS = 1h (collapses retry storms; hourly re-audit availability)."
  - "callbackResolver injected through AppDeps (defaults to real resolver in validateUrlHost when omitted) so SSRF tests mock DNS without network."
metrics:
  duration: ~20 min
  completed: 2026-06-05
  tasks: 2
  files: 8
---

# Phase 5 Plan 01: Wave 1 — Bearer Auth + POST /audit Summary

Bearer auth across every data route plus the `POST /audit` submit slice: validate -> normalize -> consumer-scoped dedup -> submit-time callback SSRF -> async insert -> `{job_id}`. All three api suites green (auth + audit-post + scaffold), db + fetch suites unchanged.

## What Was Built

### Task 1 — bearerAuth + parseApiKeys, wired into createApp (API-05) — commit bdb602f
- `middleware/auth.ts`:
  - `parseApiKeys(raw)` mirrors the `@geo/db getSql` fail-fast guard — throws on missing/empty `GEO_API_KEYS` and on an empty parsed map. Pairs are comma-separated; each pair splits on the FIRST **unescaped** `:` so tokens containing `:` survive; backslash escaping (`\,`, `\:`, `\\`) lets a token carry a literal comma/colon (D-03).
  - `bearerAuth(apiKeys)` — `createMiddleware`; `EXEMPT = {/healthz,/openapi.json,/docs}` short-circuits `next()`; reads `Authorization` case-insensitively (`/^bearer\s+/i`); resolves the consumer via `sha256`+`timingSafeEqual` (both sides hashed to fixed length → length-safe, no throw; iterates all keys for position-independent timing); on miss sets `WWW-Authenticate: Bearer realm="geo-api"` and returns `{error:'unauthorized', message}` 401; on hit `c.set('consumer_id', id)`. Authorization header never logged.
- `app.ts`: `AppDeps` extended with `apiKeys: Map<string,string>` + optional `callbackResolver`; `app.use('*', bearerAuth(deps.apiKeys))` registered before routes; typed `OpenAPIHono<{Variables:{consumer_id:string}}>`.
- `main.ts`: `parseApiKeys(process.env.GEO_API_KEYS)` at startup (fail-fast), passes the map into `createApp`.
- `index.ts`: exports `parseApiKeys`, `bearerAuth`, `EXEMPT`, `registerAuditPost`, `DEDUP_TTL_MS`, `AppVariables`, `CallbackResolver`.
- `auth.test.ts` (12 tests): parse fail-fast, first-colon split, escaped-comma token, 401 missing/invalid, length-safe (no throw), case-insensitive bearer accept, consumer_id attachment, exempt-paths tokenless.

### Task 2 — POST /audit (API-01/04/08) — route in commit bdb602f, tests in 53f7096
- `routes/audit-post.ts` registered via `app.openapi(createRoute(...))` (never `app.post`): zod body `{url: url(), callback_url?: url()}`, 200 `{job_id}`, 400/401 error envelopes, `security:[{BearerAuth:[]}]`.
  - Handler: `normalizeUrl(url)` (→ `{url,errors}`; 400 `invalid_url` on parse failure) → `sha256(normalized)` hash → `findRecentByUrlHash(hash, DEDUP_TTL_MS, consumer_id)` **consumer-scoped**; `recent && status!=='failed'` returns cached `{job_id}` (D-13) → if `callback_url`, `validateUrlHost(callback_url, {resolver: deps.callbackResolver})`; `!ok` → 400 `ssrf_blocked` (no insert) → `insertJob({url, normalizedUrl, urlHash, callbackUrl, consumerId})` → `{job_id}`. Never blocks on audit work.
- `audit-post.test.ts` (9 tests): happy path (200 + persisted consumer_id + status queued), invalid url / malformed body 400, same-consumer dedup (same job_id, 1 row), cross-consumer no-dedup (different job_id), prior-failed re-enqueue (claim→fail→re-POST→new job_id), loopback callback 400 ssrf_blocked + no insert, public callback persisted, `/audit` present in `/openapi.json`.

## Deviations from Plan

**1. [Rule 3 - Blocking] @geo/db dist types were stale during api DTS build**
- Found during: Task 2 `bun run --cwd packages/api build` (TS2554/TS2353 — `findRecentByUrlHash` 2-arg + no `consumerId` on `InsertJobInput`).
- Cause: Wave 0 modified `@geo/db` source but its `dist/*.d.ts` was not rebuilt; api DTS resolves `@geo/db` via its published types.
- Fix: `bun run --cwd packages/db build` to regenerate consumer-scoped `.d.ts`, then api DTS build passed. No source change.
- Commit: n/a (build artifact only; no tracked dist).

**2. [scope note] audit-post.ts route source landed in the Task 1 commit**
- `app.ts` imports `registerAuditPost`, so the route module had to exist for Task 1 to compile/run. The route implementation is in bdb602f; its dedicated test suite is the Task 2 commit (53f7096). Behavior unchanged from plan intent.

## Threat Model Coverage

- T-05-01-01 (spoofing/elevation): bearerAuth → 401 on missing/invalid for every non-exempt route; exemptions limited to the 3 docs/liveness paths. Proven by auth.test.ts. ✓
- T-05-01-02 (info disclosure, token compare): sha256+timingSafeEqual, all-keys iteration, Authorization never logged. ✓
- T-05-01-03 (SSRF, callback_url): `validateUrlHost` at submit → 400 + no insert on loopback. Proven by audit-post.test.ts. ✓
- T-05-01-04 (tampering, body): zod via createRoute → automatic 400. ✓
- T-05-01-05 (info disclosure, dedup): `findRecentByUrlHash` consumer-scoped equality; cross-consumer no-dedup proven. ✓

No secrets committed (test tokens are fixtures, not real keys).

## Verification

- `bun run --cwd packages/api test -- --run` → 23 passed (auth 12, audit-post 9, scaffold 2).
- `bun run --cwd packages/api build` → ESM+CJS+DTS green (after db rebuild).
- `bun run --cwd packages/db test -- --run` → 55 passed, 1 skipped (no regression).
- `bun run --cwd packages/fetch test -- --run` → 116 passed, 7 todo (no regression).

## Known Stubs

None. POST /audit is fully wired (real DAL + real SSRF validator). Poll (`GET /audit/{id}`) and history (`GET /audits`) routes are Wave 2 (plan 05-02), as designed.

## Self-Check: PASSED
