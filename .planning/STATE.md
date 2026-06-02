# Project State: geo-api

## Project Reference

**Core Value:** Any consumer app can POST a URL and get back a 0–100 GEO Score with findings, fully automated — deterministic ~80% as plain shared TS code, only irreducible judgment as a single structured LLM call.

**Repo:** `C:\Users\artic\GitHub\geo-seo-claude`
**Stack:** Bun + Hono (`@hono/zod-openapi`), `@anthropic-ai/sdk`, Coolify Postgres, `@geo/core` (zero-dep TS), Docker

---

## Current Position

**Phase:** 1 — @geo/core: Deterministic Package
**Plan:** None started
**Status:** Not started
**Branch:** main (no phase branch cut yet)

```
Progress: [ ] [ ] [ ] [ ] [ ] [ ] [ ]
           1   2   3   4   5   6   7
```

---

## Phase Summary

| # | Name | Status |
|---|------|--------|
| 1 | @geo/core — Deterministic Package | Not started |
| 2 | SSRF & Fetch Hardening | Not started |
| 3 | Postgres Schema & Durable Job Queue | Not started |
| 4 | Worker Pipeline | Not started |
| 5 | Bun+Hono API Layer | Not started |
| 6 | Containerize & Coolify Deploy | Not started |
| 7 | Cron + Consumer Wiring | Not started |

---

## Performance Metrics

- Phases completed: 0/7
- Requirements shipped: 0/35
- Plans executed: 0

---

## Accumulated Context

### Key Decisions

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

**Last session:** 2026-06-01 — roadmap created, files initialized
**Next action:** `/gsd:plan-phase 1` to plan @geo/core package

---
*State initialized: 2026-06-01*
