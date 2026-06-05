---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Phase 6 context gathered
last_updated: "2026-06-05T02:43:51.123Z"
progress:
  total_phases: 7
  completed_phases: 5
  total_plans: 20
  completed_plans: 20
  percent: 71
---

# Project State: geo-api

## Project Reference

**Core Value:** Any consumer app can POST a URL and get back a 0–100 GEO Score with findings, fully automated — deterministic ~80% as plain shared TS code, only irreducible judgment as a single structured LLM call.

**Repo:** `C:\Users\artic\GitHub\geo-seo-claude`
**Stack:** Bun + Hono (`@hono/zod-openapi`), `@anthropic-ai/sdk`, Coolify Postgres, `@geo/core` (zero-dep TS), Docker

---

## Current Position

Phase: 05 (bun-hono-api-layer) — EXECUTING
Plan: 3 of 3 COMPLETE (Wave 0 prereqs + Wave 1 auth/submit + Wave 2 read/docs/webhook)
**Phase:** 3 — Postgres Schema & Durable Job Queue — EXECUTING
**Plan:** Plan 02 COMPLETE — typed DAL + SKIP LOCKED claim + lifecycle/queue/concurrency tests (DATA-01, DATA-02, WORK-01)
**Status:** Executing Phase 05
**Branch:** phase-01-geo-core-deterministic-package

```
Progress: [█████████░] 94%
           1   2   3   4   5   6   7
```

---

## Phase Summary

| # | Name | Status |
|---|------|--------|
| 1 | @geo/core — Deterministic Package | COMPLETE (Plans 00-06, CORE-01..06) |
| 2 | SSRF & Fetch Hardening | EXECUTING (Plan 00 done) |
| 3 | Postgres Schema & Durable Job Queue | EXECUTING (Plan 00 done) |
| 4 | Worker Pipeline | Not started |
| 5 | Bun+Hono API Layer | Not started |
| 6 | Containerize & Coolify Deploy | Not started |
| 7 | Cron + Consumer Wiring | Not started |

---

## Performance Metrics

- Phases completed: 0/7
- Requirements shipped: 6/35 (CORE-01..06)
- Plans executed: 8 (Phase 1 complete, Phase 2 Plan 00 done)

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| 01-00 Walking Skeleton | ~15 min | 2 | 15 |
| 01-01 checkRobots | ~10 min | 1 | 3 |
| 01-02 llmstxt generator/validator | ~5 min | 1 | 3 |
| 01-03 schema templates + structured data | ~10 min | 1 | 4 |
| 01-04 citability scoring | ~15 min | 1 | 4 |
| 01-05 detectRendering SSR/CSR/hybrid | ~10 min | 1 | 4 |
| 01-06 phase gate + dual ESM/CJS | ~15 min | 3 | 10 |
| 02-00 @geo/fetch scaffold + IP classifier | ~10 min | 2 | 11 |
| 02-01 createSafeFetcher + resolve-then-pin | ~20 min | 2 | 6 |
| 02-02 manual redirects + per-hop SSRF | ~15 min | 2 | 5 |
| 02-03 size cap + decompression-bomb + phase gate | ~15 min | 2 | 7 |
| 03-00 @geo/db scaffold + getSql guard + PGlite harness | ~15 min | 3 | 11 |
| 03-01 migration runner + 0001_create_audits schema | ~15 min | 2 | 5 |
| 03-02 typed DAL + SKIP LOCKED claim + lease fencing + tests | ~20 min | 3 | 7 |
| 05-00 Wave 0: consumer_id DAL + SSRF POST + @geo/api scaffold | ~25 min | 3 | 19 |
| 05-01 Wave 1: bearer auth + POST /audit (validate/dedup/SSRF) | ~20 min | 2 | 8 |
| 05-02 Wave 2: GET poll/history/healthz + OpenAPI/Scalar/docs + webhook | ~30 min | 3 | 17 |

---

## Accumulated Context

### Key Decisions

- Plan 00: FetchResult.headers lowercase-keyed; normalization is caller responsibility (D-05)
- Plan 00: tsconfig ignoreDeprecations:6.0 required for TS 6.0.3 + tsup DTS + moduleResolution:bundler
- Plan 00: AI_CRAWLERS as readonly const tuple from scripts/fetch_page.py keys
- All-TS stack: Bun+Hono service + zero-dep `@geo/core` TS package
- Python scrapers ported to TS inside `@geo/core` (not reused in-process)
- Scoring = single `@anthropic-ai/sdk` structured call with JSON output schema + prompt caching (NOT `claude -p`)
- `@geo/core` lives in/alongside HOW's packages; ottolax consumes via HTTP only
- Job queue = Postgres `SELECT FOR UPDATE SKIP LOCKED` (no Redis/Celery)
- SqlExecutor interface as portable injection seam — postgres.js + PGlite both satisfy via adapters
- completeJob/failJob return bool (not throw) on stale lease_token — Phase 4 worker logs and continues
- reclaimExpired runs inside claimNextJob's transaction so expired leases are claimable in same pass
- SSRF hardening is a hard prerequisite before any URL-accepting feature ships
- isBlockedIP strategy: deny range() !== "unicast" (fail-closed D-04); ipaddr.js 2.4.0 normalizes obfuscated forms
- IPv4-mapped IPv6 unwrapped via isIPv4MappedAddress()+toIPv4Address() before range check (T-02-01)
- FetchErrorCode as const object not enum (avoids TS const-enum cross-module pitfall)
- resolve-then-pin: single resolveAndValidate call → pinned IP in URL + undici Agent(connect.servername=hostname) — no dns-interceptor
- Direct IP literals (decimal/octal/hex/IPv4-mapped IPv6) detected and blocked without DNS round-trip
- _testDispatcher seam in SafeFetcherOptions: post-validation only; resolveAndValidate always runs in production
- `callback_url` webhook uses same SSRF guard as audit URL
- makeByteCounter placed after final decompressor so cap is on decompressed bytes (02-03)
- stacked encoding cap is 2; enforced synchronously in buildDecompressChain before streaming (02-03)
- tsconfig.check.json created (rootDir='.') for tsc --noEmit including test helpers (02-03)
- Flask CRM (`scripts/webapp/app.py`) untouched this milestone
- 05-00: consumer dedup/history use `consumer_id = $consumer` equality (legacy null rows never match)
- 05-00: @hono/zod-openapi@0.19.10 + @scalar/hono-api-reference@0.10.20 keep zod v3 (3.25.51); Scalar's nested zod v4 is isolated
- 05-00: validateUrl exported from safe-fetcher and reused by safe-requester (SSRF POST), no validator duplication
- 05-00: createApp({dal,fetcher}) DI factory — no module-level singleton DAL
- 05-01: GEO_API_KEYS parse splits on FIRST unescaped ':'; backslash escaping for ','/':'-bearing tokens (D-03)
- 05-01: token compare = sha256 both sides → timingSafeEqual (length-safe, all-keys iteration for timing)
- 05-01: DEDUP_TTL_MS=1h; consumer-scoped dedup skips status==='failed' (re-enqueue, D-13)
- 05-01: callbackResolver injected via AppDeps so submit-time SSRF check is testable without network
- 05-02: response DTOs explicit (no raw AuditJob row); internal columns never serialized (D-15); poll findings = z.record (z.unknown collapses DTS body to never)
- 05-02: GET /audit + /audits ownership-scoped 404 / consumer-equality history (no cross-consumer read)
- 05-02: /healthz deep check via additive AuditDal.ping() (SELECT 1); tests force 503 by closing PGlite
- 05-02: BearerAuth registered via registerComponent; docs/api.md generated by scripts/gen-docs (rule 21)
- 05-02: webhook fired non-fatally (void+.catch) at completeJob + 3 terminal failJob sites; fire-time SSRF re-validation via real createSafeRequester (API-08, D-08/D-12)

### Architecture Pointers

- Bootstrap from `_templates/bun-hono-app/` (global rule 21)
- `DATABASE_URL` + `ANTHROPIC_API_KEY` + auth key → Coolify env only
- `/openapi.json` + `/docs` (Scalar) mandatory (global rule 21)
- Deploy verify = `/healthz` + real audit round-trip (global rule 14)

### Blockers

None.

### Open TODOs

- Cut phase-1 branch before starting implementation
- Confirm HOW's monorepo `packages/` path for @geo/core placement
- Confirm Coolify app UUID for deploy wiring (Phase 6)

---

## Session Continuity

**Last session:** 2026-06-05T02:43:51.114Z
**Stopped at:** Phase 6 context gathered
**Next action:** Phase 4 — Worker Pipeline (claim/complete/fail/reclaim wiring + scoring)

---
*State initialized: 2026-06-01*
