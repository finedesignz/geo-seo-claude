---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: completed
stopped_at: Phase 3 Plan 02 complete (DAL + SKIP LOCKED claim, 48 tests green + 1 skipped)
last_updated: "2026-06-03T01:28:16.808Z"
progress:
  total_phases: 7
  completed_phases: 4
  total_plans: 17
  completed_plans: 17
  percent: 57
---

# Project State: geo-api

## Project Reference

**Core Value:** Any consumer app can POST a URL and get back a 0–100 GEO Score with findings, fully automated — deterministic ~80% as plain shared TS code, only irreducible judgment as a single structured LLM call.

**Repo:** `C:\Users\artic\GitHub\geo-seo-claude`
**Stack:** Bun + Hono (`@hono/zod-openapi`), `@anthropic-ai/sdk`, Coolify Postgres, `@geo/core` (zero-dep TS), Docker

---

## Current Position

Phase: 3 (postgres-schema-durable-job-queue) — EXECUTING
Plan: 2 of 3
**Phase:** 3 — Postgres Schema & Durable Job Queue — EXECUTING
**Plan:** Plan 02 COMPLETE — typed DAL + SKIP LOCKED claim + lifecycle/queue/concurrency tests (DATA-01, DATA-02, WORK-01)
**Status:** Phase 3 COMPLETE — all 3 plans done
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

**Last session:** 2026-06-03T01:28:16.801Z
**Stopped at:** Phase 3 Plan 02 complete (DAL + SKIP LOCKED claim, 48 tests green + 1 skipped)
**Next action:** Phase 4 — Worker Pipeline (claim/complete/fail/reclaim wiring + scoring)

---
*State initialized: 2026-06-01*
