---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Phase 1 Plan 02 complete (CORE-02 llmstxt)
last_updated: "2026-06-02T19:16:07.460Z"
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 7
  completed_plans: 4
  percent: 0
---

# Project State: geo-api

## Project Reference

**Core Value:** Any consumer app can POST a URL and get back a 0–100 GEO Score with findings, fully automated — deterministic ~80% as plain shared TS code, only irreducible judgment as a single structured LLM call.

**Repo:** `C:\Users\artic\GitHub\geo-seo-claude`
**Stack:** Bun + Hono (`@hono/zod-openapi`), `@anthropic-ai/sdk`, Coolify Postgres, `@geo/core` (zero-dep TS), Docker

---

## Current Position

Phase: 1 (geo-core-deterministic-package) — EXECUTING
Plan: 2 of 7
**Phase:** 1 — @geo/core: Deterministic Package
**Plan:** Plan 00 COMPLETE — Plan 01 next
**Status:** Executing Phase 1
**Branch:** phase-01-geo-core-deterministic-package

```
Progress: [██████░░░░] 57%
           1   2   3   4   5   6   7
```

---

## Phase Summary

| # | Name | Status |
|---|------|--------|
| 1 | @geo/core — Deterministic Package | Plan 00 complete (walking skeleton) |
| 2 | SSRF & Fetch Hardening | Not started |
| 3 | Postgres Schema & Durable Job Queue | Not started |
| 4 | Worker Pipeline | Not started |
| 5 | Bun+Hono API Layer | Not started |
| 6 | Containerize & Coolify Deploy | Not started |
| 7 | Cron + Consumer Wiring | Not started |

---

## Performance Metrics

- Phases completed: 0/7
- Requirements shipped: 2/35 (CORE-06, CORE-02)
- Plans executed: 1

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| 01-00 Walking Skeleton | ~15 min | 2 | 15 |
| 01-02 llmstxt generator/validator | ~5 min | 1 | 3 |

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

**Last session:** 2026-06-02T19:16:07.453Z
**Stopped at:** Phase 1 Plan 02 complete (CORE-02 llmstxt)
**Next action:** Execute Plan 03 (next plan in phase 1)

---
*State initialized: 2026-06-01*
