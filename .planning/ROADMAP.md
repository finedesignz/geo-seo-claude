# Roadmap: geo-api

**Project:** geo-api
**Milestone:** v1 — Automated GEO Audit Service
**Granularity:** Fine
**Coverage:** 35/35 requirements mapped

---

## Phases

- [ ] **Phase 1: @geo/core — Deterministic Package** - Zero-dep TS package with all deterministic audit functions (crawl, llms.txt, schema, citability, SSR/CSR detection), usable by HOW and the service
- [ ] **Phase 2: SSRF & Fetch Hardening** - Harden URL fetcher to block SSRF vectors, DNS-rebinding, redirect chains, size caps — prerequisite for all URL-accepting features
- [ ] **Phase 3: Postgres Schema & Durable Job Queue** - Coolify Postgres schema with migration management, job state machine, and SKIP LOCKED worker queue
- [ ] **Phase 4: Worker Pipeline** - Background worker claiming jobs, running @geo/core deterministic checks + structured Anthropic SDK scoring call, persisting results
- [ ] **Phase 5: Bun+Hono API Layer** - POST/GET /audit endpoints, auth, dedup, webhook, history, /healthz, /openapi.json + /docs
- [ ] **Phase 6: Containerize & Coolify Deploy** - Container image for API + worker, Coolify service setup, env-sourced secrets, deploy verification
- [ ] **Phase 7: Cron + Consumer Wiring** - Scheduled re-audit cron container, HOW inline @geo/core integration, ottolax HTTP consumer integration

---

## Phase Details

### Phase 1: @geo/core — Deterministic Package
**Goal**: A zero-dependency TypeScript package of deterministic GEO audit functions is published and importable by both `hyperoptimizedwebsites` and the geo-api service without making any LLM calls.
**Mode:** mvp
**Depends on**: Nothing
**Requirements**: CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, CORE-06
**Success Criteria** (what must be TRUE):
  1. `@geo/core` can be imported in a TS project and `checkRobots(url)` returns a structured crawlability result
  2. `generateLlmsTxt(crawlData)` returns a valid llms.txt string for a site
  3. `getSchemaTemplates(pageData)` returns schema.org templates and validates existing structured data
  4. `computeCitabilityScore(pageData)` returns numeric sub-scores with no LLM calls
  5. `detectRendering(url)` classifies a URL as SSR or CSR deterministically
**Plans**: 7 plans
  - [x] 01-00-PLAN.md — Walking Skeleton: Bun workspace + @geo/core scaffold, tsup dual build, vitest, FetchResult/Fetcher seam, one real fn end-to-end (Wave 0)
  - [x] 01-01-PLAN.md — CORE-01 checkRobots: robots.txt + AI-crawler crawlability + sitemap-bug fix (Wave 1)
  - [ ] 01-02-PLAN.md — CORE-02 generateLlmsTxt + validateLlmsTxt (Wave 1)
  - [ ] 01-03-PLAN.md — CORE-03 getSchemaTemplates + zero-dep JSON-LD validateStructuredData (Wave 1)
  - [ ] 01-04-PLAN.md — CORE-04 computeCitabilityScore + CITABILITY_WEIGHTS (TDD) (Wave 1)
  - [ ] 01-05-PLAN.md — CORE-05 detectRendering multi-signal SSR/CSR (Wave 1)
  - [ ] 01-06-PLAN.md — CORE-06 dual ESM+CJS consumability + zero-dep + full-suite phase gate (Wave 2)

### Phase 2: SSRF & Fetch Hardening
**Goal**: The URL fetch layer is hardened against SSRF, DNS-rebinding, redirect abuse, and response-size attacks before any URL is accepted over HTTP.
**Mode:** mvp
**Depends on**: Phase 1 (fetch utility used by @geo/core and worker)
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04, SEC-05
**Success Criteria** (what must be TRUE):
  1. Fetching `http://169.254.169.254/latest/meta-data/` returns a structured SSRF-blocked error, never a response body
  2. A URL that resolves to a private/loopback IP (10.x, 192.168.x, 127.x) is blocked after DNS resolution
  3. A redirect chain that pivots to a private IP is blocked at the redirect step, not silently followed
  4. A response exceeding the size cap or triggering decompression inflation fails with a clear structured error
  5. All blocked fetches produce a job-level `failed` status with a machine-readable error code
**Plans**: TBD

### Phase 3: Postgres Schema & Durable Job Queue
**Goal**: Audit jobs and results are durably stored in Coolify Postgres with a versioned schema and a correct SKIP LOCKED job queue that survives service restarts.
**Mode:** mvp
**Depends on**: Nothing (can be built in parallel with Phase 1–2)
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04, WORK-01
**Success Criteria** (what must be TRUE):
  1. Running migrations on a fresh Postgres instance produces the jobs table with all required columns (id, url, status, score, findings, timestamps)
  2. A job inserted as `queued` is claimable via `SELECT FOR UPDATE SKIP LOCKED` and transitions to `running` → `done | failed`
  3. Killing and restarting the service does not leave jobs permanently stuck in `running` (lease/timeout detection works)
  4. `DATABASE_URL` is never present in any committed file; service reads it from env only
**Plans**: TBD

### Phase 4: Worker Pipeline
**Goal**: A background worker reliably runs the full audit pipeline — @geo/core deterministic checks followed by a single structured Anthropic SDK scoring call — and persists the 0–100 result.
**Mode:** mvp
**Depends on**: Phase 1, Phase 2, Phase 3
**Requirements**: SCORE-01, SCORE-02, SCORE-03, SCORE-04, WORK-02, WORK-03, WORK-04
**Success Criteria** (what must be TRUE):
  1. Given a queued job, the worker runs @geo/core checks and passes their output (not raw HTML) as context to a single `@anthropic-ai/sdk` structured call with a JSON output schema
  2. The scoring prompt's static section is prompt-cached (verified via usage metadata in the API response)
  3. A completed job has a numeric `score` (0–100) and structured `findings` persisted in Postgres
  4. A scoring call that times out or returns malformed output marks the job `failed` with a retryable status code — no partial score is written
  5. Concurrency is capped: no more than N simultaneous audits run (N is configurable); excess jobs wait in queue
**Plans**: TBD

### Phase 5: Bun+Hono API Layer
**Goal**: The Bun+Hono service exposes a complete, authenticated REST API with async submit/poll, history, dedup, webhook, health, and full OpenAPI/Scalar docs.
**Mode:** mvp
**Depends on**: Phase 2, Phase 3 (Phase 4 for end-to-end smoke test)
**Requirements**: API-01, API-02, API-03, API-04, API-05, API-06, API-07, API-08
**Success Criteria** (what must be TRUE):
  1. `POST /audit` with a valid bearer token and URL returns `{ job_id }` immediately; the same URL within TTL returns the cached job_id
  2. `GET /audit/{job_id}` returns `{ status: "done", score: <number>, findings: {...} }` when the worker has finished
  3. `GET /audits` returns a paginated list of past audits for the authenticated consumer
  4. An unauthenticated request to any endpoint returns 401 (not 200 or 404)
  5. `GET /healthz` returns 200 with `{ db: "ok" }` when Postgres is reachable, and a non-200 when it is not
  6. `GET /openapi.json` returns a valid OpenAPI 3.x document; `GET /docs` renders Scalar UI
  7. A `callback_url` on submit is called with job result on completion and is rejected if it resolves to a private IP (same SSRF guard)
**Plans**: TBD
**UI hint**: no

### Phase 6: Containerize & Coolify Deploy
**Goal**: The API and worker ship as a container image deployed on Coolify with all secrets from env, verified by a live /healthz + audit round-trip.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: DEPLOY-01, DEPLOY-02 (cron container — partially; cron logic lands in Phase 7), DEPLOY-03, DEPLOY-04
**Success Criteria** (what must be TRUE):
  1. `docker build` produces a single image that can run either API or worker mode via an env/command flag
  2. The Coolify service starts, passes `/healthz` (DB reachable), and completes a real `POST /audit` → poll → result round-trip against a live URL
  3. No secret (DATABASE_URL, ANTHROPIC_API_KEY, API auth key) appears in the image or any committed file
  4. A service redeploy (new image push) does not lose in-flight or queued jobs
**Plans**: TBD

### Phase 7: Cron + Consumer Wiring
**Goal**: Scheduled re-audits run automatically, hyperoptimizedwebsites imports @geo/core inline, and ottolax triggers on-demand audits over HTTP — both consumers fully wired.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: DEPLOY-02, CONS-01, CONS-02
**Success Criteria** (what must be TRUE):
  1. The cron container fires on schedule and posts re-audit requests for each configured URL via `POST /audit`, with results visible in audit history
  2. `hyperoptimizedwebsites` can call `@geo/core` functions (e.g. `checkRobots`, `detectRendering`) without making any HTTP call to the geo-api service
  3. `ottolax` (Python) can `POST /audit` with a bearer token, poll `GET /audit/{id}`, and receive a structured score + findings response
**Plans**: TBD

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. @geo/core — Deterministic Package | 2/7 | In Progress|  |
| 2. SSRF & Fetch Hardening | 0/0 | Not started | - |
| 3. Postgres Schema & Durable Job Queue | 0/0 | Not started | - |
| 4. Worker Pipeline | 0/0 | Not started | - |
| 5. Bun+Hono API Layer | 0/0 | Not started | - |
| 6. Containerize & Coolify Deploy | 0/0 | Not started | - |
| 7. Cron + Consumer Wiring | 0/0 | Not started | - |

---
*Roadmap created: 2026-06-01*
*Last updated: 2026-06-01 after initial creation*
