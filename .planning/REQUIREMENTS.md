# Requirements: geo-api

**Defined:** 2026-06-01
**Core Value:** Any consumer app can POST a URL and get back a 0–100 GEO Score with findings, fully automated — with the deterministic ~80% as plain shared code and only the irreducible judgment as a single structured LLM call.

## v1 Requirements

### Shared Core (`@geo/core`)

Zero-dependency TypeScript package of deterministic functions. Imported inline by `hyperoptimizedwebsites` and by the service. No requirement in this category may call an LLM.

- [ ] **CORE-01**: `@geo/core` exposes a crawl/robots.txt fetch + parse function (can the page be fetched; is it crawlable by AI bots)
- [ ] **CORE-02**: `@geo/core` generates an `llms.txt` for a given site from crawl data
- [ ] **CORE-03**: `@geo/core` provides schema.org / structured-data templates + a validator for a page
- [ ] **CORE-04**: `@geo/core` computes a citability heuristic (deterministic sub-scores feeding the final GEO score)
- [ ] **CORE-05**: `@geo/core` detects SSR vs CSR rendering for a URL
- [ ] **CORE-06**: `@geo/core` is published/consumable as a zero-dep package and imported inline by `hyperoptimizedwebsites` (no service round-trip for deterministic checks)

### Security / Fetch Hardening

Prerequisite — nothing that accepts a URL ships before this.

- [ ] **SEC-01**: URL fetcher blocks private, link-local, loopback, and cloud-metadata IPs (e.g. 169.254.169.254) including after DNS resolution
- [ ] **SEC-02**: URL fetcher is DNS-rebinding safe (resolve-then-pin, re-validate on redirect)
- [ ] **SEC-03**: URL fetcher validates and re-checks every redirect hop against the SSRF allowlist
- [ ] **SEC-04**: URL fetcher enforces a response-size cap and is decompression-bomb safe
- [ ] **SEC-05**: An SSRF-blocked or oversized fetch fails the job with a clear, structured error (no partial/unsafe result)

### Scoring

- [ ] **SCORE-01**: The 0–100 GEO Score is produced by a single structured Anthropic SDK call using a JSON output schema (no `claude -p`, no agent host)
- [ ] **SCORE-02**: The scoring prompt is fed the deterministic `@geo/core` findings as input; the LLM renders only the irreducible judgment
- [ ] **SCORE-03**: The scoring call uses prompt caching for the static portion of the prompt
- [ ] **SCORE-04**: A scoring-call failure (timeout, rate limit, malformed output) fails the job cleanly with a ret[r]yable status, never a partial score

### Persistence

- [ ] **DATA-01**: Audit jobs and results are stored in Coolify Postgres (job id, url, status, score, findings, timestamps)
- [ ] **DATA-02**: Job state machine is durable: `queued → running → done | failed` survives a service redeploy
- [ ] **DATA-03**: `DATABASE_URL` is read from Coolify env, never committed
- [ ] **DATA-04**: Schema is migration-managed (versioned, repeatable)

### API (Bun + Hono service)

- [ ] **API-01**: `POST /audit {url}` validates input and returns `{ job_id }` (async; does not block on the audit)
- [ ] **API-02**: `GET /audit/{job_id}` returns status, and on completion the 0–100 score + findings
- [ ] **API-03**: `GET /audits` lists audit history with pagination
- [ ] **API-04**: Recent-audit dedup/caching: a repeat audit of the same URL within a TTL returns the cached result instead of re-running
- [ ] **API-05**: All endpoints require auth (bearer/API key); consumer apps authenticate, no anonymous access
- [ ] **API-06**: `GET /healthz` returns a deep health signal (DB reachable), not just process-up
- [ ] **API-07**: Service exposes `/openapi.json` + `/docs` (Scalar) per global rule 21
- [ ] **API-08**: A `callback_url` (webhook) on submit is notified on job completion, and the `callback_url` passes the SAME SSRF check as the audit URL

### Worker / Job Runner

- [ ] **WORK-01**: A worker claims queued jobs from Postgres using `SELECT … FOR UPDATE SKIP LOCKED` (no Redis/Celery broker)
- [ ] **WORK-02**: The worker runs the audit pipeline: `@geo/core` deterministic checks → structured scoring call → persist result
- [ ] **WORK-03**: Concurrency is capped (bounded simultaneous audits); excess jobs wait
- [ ] **WORK-04**: A crashed/stuck job is detectable and recoverable (lease/timeout), not stuck `running` forever

### Deploy / Operations

- [ ] **DEPLOY-01**: Service + worker ship as a container image; the worker runs as a separate Coolify service (or process) from the API
- [ ] **DEPLOY-02**: A cron container re-audits a configured list of sites on a schedule, calling the same `/audit` path
- [ ] **DEPLOY-03**: Secrets (DB, Anthropic API key, service auth) come from Coolify env — none baked into the image
- [ ] **DEPLOY-04**: Deploy verified by probing `/healthz` + a real `/audit` round-trip, not `/health` alone (global rule 14)

### Consumer Wiring

- [ ] **CONS-01**: `hyperoptimizedwebsites` (TS) imports `@geo/core` inline for cheap checks AND can call the service for a full audit
- [ ] **CONS-02**: `ottolax` (Python) triggers an on-demand audit via the service's HTTP API and reads back the result

## v2 Requirements

### Reporting

- **REP-01**: PDF report endpoint for a completed audit
- **REP-02**: Score-over-time history/trend per site

### Operations

- **OPS-01**: Rate limiting per consumer/API key
- **OPS-02**: Idempotency keys on `POST /audit`

## Out of Scope

| Feature | Reason |
|---------|--------|
| `claude -p` / agent-host scoring | Score is a structured SDK call; revisit only if a real multi-step tool-use-during-audit driver (#3) appears |
| Routing deterministic checks through an LLM | They are plain `@geo/core` functions; LLM-routing them is the exact waste to prevent |
| Reusing Python scrapers in-process | All-TS decision; scrapers ported to `@geo/core` (TS) for one source of truth |
| Replacing/migrating the Flask CRM (`scripts/webapp/app.py`) | Out of scope this milestone; keep as-is |
| Synchronous `/audit` endpoint | Audits take tens of seconds–minutes; async job model only |
| WebSocket result streaming | Polling + optional webhook callback suffice for an internal 2-consumer service |
| Multi-tenant billing / Titanium licensing | Internal service for now |
| Admin UI for geo-api | Consumer apps own their UIs |
| GraphQL / gRPC surface | REST + OpenAPI sufficient for these consumers |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CORE-01 | Phase 1: @geo/core — Deterministic Package | Pending |
| CORE-02 | Phase 1: @geo/core — Deterministic Package | Pending |
| CORE-03 | Phase 1: @geo/core — Deterministic Package | Pending |
| CORE-04 | Phase 1: @geo/core — Deterministic Package | Pending |
| CORE-05 | Phase 1: @geo/core — Deterministic Package | Pending |
| CORE-06 | Phase 1: @geo/core — Deterministic Package | Pending |
| SEC-01 | Phase 2: SSRF & Fetch Hardening | Pending |
| SEC-02 | Phase 2: SSRF & Fetch Hardening | Pending |
| SEC-03 | Phase 2: SSRF & Fetch Hardening | Pending |
| SEC-04 | Phase 2: SSRF & Fetch Hardening | Pending |
| SEC-05 | Phase 2: SSRF & Fetch Hardening | Pending |
| DATA-01 | Phase 3: Postgres Schema & Durable Job Queue | Pending |
| DATA-02 | Phase 3: Postgres Schema & Durable Job Queue | Pending |
| DATA-03 | Phase 3: Postgres Schema & Durable Job Queue | Pending |
| DATA-04 | Phase 3: Postgres Schema & Durable Job Queue | Pending |
| WORK-01 | Phase 3: Postgres Schema & Durable Job Queue | Pending |
| SCORE-01 | Phase 4: Worker Pipeline | Pending |
| SCORE-02 | Phase 4: Worker Pipeline | Pending |
| SCORE-03 | Phase 4: Worker Pipeline | Pending |
| SCORE-04 | Phase 4: Worker Pipeline | Pending |
| WORK-02 | Phase 4: Worker Pipeline | Pending |
| WORK-03 | Phase 4: Worker Pipeline | Pending |
| WORK-04 | Phase 4: Worker Pipeline | Pending |
| API-01 | Phase 5: Bun+Hono API Layer | Pending |
| API-02 | Phase 5: Bun+Hono API Layer | Pending |
| API-03 | Phase 5: Bun+Hono API Layer | Pending |
| API-04 | Phase 5: Bun+Hono API Layer | Pending |
| API-05 | Phase 5: Bun+Hono API Layer | Pending |
| API-06 | Phase 5: Bun+Hono API Layer | Pending |
| API-07 | Phase 5: Bun+Hono API Layer | Pending |
| API-08 | Phase 5: Bun+Hono API Layer | Pending |
| DEPLOY-01 | Phase 6: Containerize & Coolify Deploy | Pending |
| DEPLOY-03 | Phase 6: Containerize & Coolify Deploy | Pending |
| DEPLOY-04 | Phase 6: Containerize & Coolify Deploy | Pending |
| DEPLOY-02 | Phase 7: Cron + Consumer Wiring | Pending |
| CONS-01 | Phase 7: Cron + Consumer Wiring | Pending |
| CONS-02 | Phase 7: Cron + Consumer Wiring | Pending |

**Coverage:**
- v1 requirements: 35 total
- Mapped to phases: 35 ✓
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-01*
*Last updated: 2026-06-01 — traceability populated by roadmapper*
