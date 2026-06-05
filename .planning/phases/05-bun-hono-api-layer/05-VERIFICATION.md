---
phase: 05-bun-hono-api-layer
verified: 2026-06-04T00:00:00Z
status: passed
score: 7/7 success criteria + 8/8 requirements verified
verifier: Claude Opus 4.8 (1M context) — gsd-verifier
mode: mvp
re_verification: false
ship_verdict: SHIP
deferred:
  - truth: "Live /healthz against real Postgres returns 200 {db:ok}"
    addressed_in: "Phase 6"
    evidence: "Phase 6 SC#2: Coolify service passes /healthz (DB reachable)"
  - truth: "Real POST /audit -> poll -> result round-trip against a live URL"
    addressed_in: "Phase 6"
    evidence: "Phase 6 SC#2: completes a real POST /audit -> poll -> result round-trip"
  - truth: "Real webhook delivery to an external callback_url at fire time"
    addressed_in: "Phase 6"
    evidence: "Environment-constrained (no live consumer endpoint); documented in 05-VALIDATION.md"
---

# Phase 5: Bun+Hono API Layer — Verification Report

**Phase Goal:** The Bun+Hono service exposes a complete, authenticated REST API with async submit/poll, history, dedup, webhook, health, and full OpenAPI/Scalar docs.
**Verified:** 2026-06-04
**Status:** passed
**Re-verification:** No — initial verification
**Mode:** mvp

## Test Execution (run by verifier with the package vitest runner, not `bun test`)

| Suite | Command | Result |
| ----- | ------- | ------ |
| @geo/api | `bun run test -- --run` | 7 files, **40 passed** |
| @geo/worker | `bun run test -- --run` | 5 files, **38 passed** |
| @geo/fetch | `bun run test -- --run` | 9 files, **116 passed + 7 todo** |
| @geo/db | `bun run test -- --run` | 8 files, **55 passed + 1 skip** |
| @geo/api build | `bun run build` | tsup ESM+CJS+DTS **success** |

Note: an initial `bun test` (Bun native runner) produced false failures (`vi.advanceTimersByTimeAsync`/`mockAgent.close` undefined, PGlite). Those are Bun-vs-vitest harness incompatibilities, NOT product defects — every suite is green under its declared `vitest` runner.

## Success Criteria (ROADMAP Phase 5)

| # | Criterion | Status | Evidence |
| - | --------- | ------ | -------- |
| 1 | POST /audit returns `{job_id}` immediately; same URL within TTL returns cached job_id | ✓ PASS | `routes/audit-post.ts` async insert + `findRecentByUrlHash` dedup (status!=failed); DEDUP_TTL_MS=1h; `audit-post.test.ts` green |
| 2 | GET /audit/{id} returns done status+score+findings | ✓ PASS | `routes/audit-get.ts` PollResponse DTO; `audit-get.test.ts` green |
| 3 | GET /audits paginated list for the consumer | ✓ PASS | `routes/audits-list.ts` page/limit/offset, `listJobs({consumerId})`; `audits-list.test.ts` green |
| 4 | Data routes 401 unauth; /healthz+/openapi.json+/docs public (amended) | ✓ PASS | `middleware/auth.ts` `EXEMPT = {/healthz,/openapi.json,/docs}`; `auth.test.ts` green |
| 5 | GET /healthz 200 `{db:ok}` reachable, non-200 when not | ✓ PASS | `routes/healthz.ts` deep `dal.ping()` SELECT 1 -> 200/503; `healthz.test.ts` green (live DB DEFERRED to Phase 6) |
| 6 | /openapi.json valid OpenAPI 3.x; /docs Scalar UI | ✓ PASS | `app.ts` `doc31("/openapi.json",{openapi:"3.1.0"})` + Scalar `/docs`; `openapi.test.ts` asserts 3.x + BearerAuth |
| 7 | callback_url called on completion; rejected if private IP (same SSRF guard) | ✓ PASS | submit-time `validateUrlHost` -> 400; fire-time `createSafeRequester` re-resolves per attempt (TOCTOU); `webhook.ts` non-fatal (real delivery DEFERRED to Phase 6) |

**Success criteria score: 7/7**

## Requirements Coverage (API-01..API-08)

| Req | Description | Status | Evidence |
| --- | ----------- | ------ | -------- |
| API-01 | Async submit returns job_id without blocking | ✓ SATISFIED | `audit-post.ts` returns before worker runs; immediate insert |
| API-02 | Poll, ownership-scoped 404 (no existence leak) | ✓ SATISFIED | `audit-get.ts`: `!job || job.consumerId !== consumerId -> 404` |
| API-03 | Paginated, consumer-scoped history | ✓ SATISFIED | `audits-list.ts` + DAL `listJobs` consumer filter |
| API-04 | Dedup within TTL cached; failed re-enqueues; **CONSUMER-SCOPED** | ✓ SATISFIED | `dal.ts:344` `findRecentByUrlHash` uses `AND consumer_id = $3` EQUALITY (NULL never matches — folded HIGH fix confirmed); route skips `status==='failed'` |
| API-05 | Bearer 401 on every data route; docs surface exempt; consumer_id attached | ✓ SATISFIED | `auth.ts` EXEMPT set, `c.set('consumer_id',...)`, length-safe constant-time compare |
| API-06 | /healthz deep SELECT 1 -> 200/503 | ✓ SATISFIED | `healthz.ts` + `dal.ping()` |
| API-07 | OpenAPI 3.x + BearerAuth scheme; /docs Scalar 200; docs/api.md committed | ✓ SATISFIED | `app.ts` registers `securitySchemes.BearerAuth`; `docs/api.md` git-tracked + generated header |
| API-08 | callback_url SSRF at submit (400) AND webhook re-validates at fire (TOCTOU), non-fatal | ✓ SATISFIED | `audit-post.ts` 400 ssrf_blocked; `safe-requester.ts` per-attempt `validateUrl`; `webhook.ts` swallows all failures |

**Requirements score: 8/8**

## Additional Hardening Checks

| Check | Status | Evidence |
| ----- | ------ | -------- |
| Response DTOs exclude internal columns (D-15) | ✓ PASS | `audit-get.ts` + `audits-list.ts` build explicit DTO, never spread row; callback_url/lease_token/attempts/locked_at/lease_expires_at/consumer_id never serialized |
| GEO_API_KEYS env-only fail-fast | ✓ PASS | `auth.ts` `parseApiKeys` throws on missing/empty; `main.ts` calls it at startup |
| Length-safe constant-time key compare | ✓ PASS | `auth.ts` sha256 both sides (fixed length) + `timingSafeEqual`, iterates all keys (no early return) |
| No prod DB in tests | ✓ PASS | `pglite-helper.ts` uses in-memory PGlite with real migrations; "never the prod DATABASE_URL" |
| Migration 0002 additive/non-breaking | ✓ PASS | `0002_add_consumer_id.sql` nullable col + partial index `WHERE consumer_id IS NOT NULL`, IF NOT EXISTS guards |
| No debt markers (TBD/FIXME/XXX) in src | ✓ PASS | grep clean across `packages/api/src` |

## Data-Flow / Wiring

- `app.ts` mounts bearerAuth on `*`, registers all 4 routes, doc31 + Scalar. All routes use OpenAPI-first `app.openapi(route,...)` (never `app.post`).
- DAL injected via `createApp({dal,fetcher,apiKeys})` — no module-level singleton; tests inject PGlite DAL.
- Webhook requester injectable; production default `createSafeRequester` pins validated IP + blocks redirects.

## Deferred (environment-constrained → Phase 6 deploy-verify)

| Item | Addressed In | Reason |
| ---- | ------------ | ------ |
| Live /healthz against real Postgres | Phase 6 | No live DB in CI; logic + 503 path unit-tested |
| Real POST /audit -> poll -> result round-trip | Phase 6 | Requires deployed worker + DB |
| Real webhook delivery to external endpoint | Phase 6 | No live consumer endpoint; SSRF guard + non-fatal path unit-tested |

These are documented in 05-VALIDATION.md and are NOT gaps.

## Gaps

None.

## Ship Verdict

**SHIP** — All 7 success criteria PASS, all 8 requirements SATISFIED, all hardening checks (consumer-scoped dedup HIGH fix, TOCTOU webhook re-validation, DTO leak prevention, constant-time auth, env fail-fast, test DB isolation) verified against source. Every package test suite green under its declared vitest runner; build emits OpenAPI 3.1 spec + committed docs/api.md. Three round-trip behaviors are correctly DEFERRED to Phase 6 deploy-verify (environment-constrained, documented).

---

_Verified: 2026-06-04_
_Verifier: Claude Opus 4.8 (1M context) (gsd-verifier)_
