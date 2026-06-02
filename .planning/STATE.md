---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Phase 2 Plan 01 complete (createSafeFetcher — resolve-then-pin, scheme/port/userinfo blocks, SEC-01/02/05)
last_updated: "2026-06-02T13:10:00.000Z"
progress:
  total_phases: 7
  completed_phases: 1
  total_plans: 11
  completed_plans: 9
  percent: 20
---

# Project State: geo-api

## Project Reference

**Core Value:** Any consumer app can POST a URL and get back a 0–100 GEO Score with findings, fully automated — deterministic ~80% as plain shared TS code, only irreducible judgment as a single structured LLM call.

**Repo:** `C:\Users\artic\GitHub\geo-seo-claude`
**Stack:** Bun + Hono (`@hono/zod-openapi`), `@anthropic-ai/sdk`, Coolify Postgres, `@geo/core` (zero-dep TS), Docker

---

## Current Position

Phase: 2 (ssrf-fetch-hardening) — EXECUTING
Plan: 1 of 4
**Phase:** 2 — SSRF & Fetch Hardening — EXECUTING
**Plan:** Plan 01 COMPLETE — createSafeFetcher, resolve-then-pin, scheme/port blocks
**Status:** Executing Phase 2, Plan 02 next
**Branch:** phase-01-geo-core-deterministic-package

```
Progress: [██░░░░░░░░] 18%
           1   2   3   4   5   6   7
```

---

## Phase Summary

| # | Name | Status |
|---|------|--------|
| 1 | @geo/core — Deterministic Package | COMPLETE (Plans 00-06, CORE-01..06) |
| 2 | SSRF & Fetch Hardening | EXECUTING (Plan 00 done) |
| 3 | Postgres Schema & Durable Job Queue | Not started |
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
- SSRF hardening is a hard prerequisite before any URL-accepting feature ships
- isBlockedIP strategy: deny range() !== "unicast" (fail-closed D-04); ipaddr.js 2.4.0 normalizes obfuscated forms
- IPv4-mapped IPv6 unwrapped via isIPv4MappedAddress()+toIPv4Address() before range check (T-02-01)
- FetchErrorCode as const object not enum (avoids TS const-enum cross-module pitfall)
- resolve-then-pin: single resolveAndValidate call → pinned IP in URL + undici Agent(connect.servername=hostname) — no dns-interceptor
- Direct IP literals (decimal/octal/hex/IPv4-mapped IPv6) detected and blocked without DNS round-trip
- _testDispatcher seam in SafeFetcherOptions: post-validation only; resolveAndValidate always runs in production
- `callback_url` webhook uses same SSRF guard as audit URL
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

**Last session:** 2026-06-02T13:10:00.000Z
**Stopped at:** Phase 2 Plan 01 complete (createSafeFetcher, resolve-then-pin, SEC-01/02/05)
**Next action:** Phase 2 Plan 02 — redirect chain + per-hop SSRF re-validation (Wave 2)

---
*State initialized: 2026-06-01*
