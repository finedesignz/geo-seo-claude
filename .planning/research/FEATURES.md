# Feature Research

**Domain:** Async job-based audit/analysis HTTP API (internal service)
**Researched:** 2026-06-01
**Confidence:** HIGH (internal service with known consumers; no market research needed)

## Feature Landscape

### Table Stakes (Consumers Expect These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| `POST /audits` → `{job_id, status}` | Core submit-and-forget pattern; consumers can't block waiting 30-120s | LOW | Returns 202 Accepted; job_id is the tracking handle |
| `GET /audits/{job_id}` → status + result | Consumers need to poll until done | LOW | States: `pending`, `running`, `completed`, `failed` |
| Structured result schema | Consumers codegen types from OpenAPI; shape must be stable | MEDIUM | `{job_id, url, geo_score, findings[], created_at, completed_at, error?}` |
| Structured error schema | Consumers must distinguish audit failure from API error | LOW | `{code, message, detail}` — never bare 500s |
| `/healthz` | Coolify health checks; consumer readiness probe | LOW | Returns `{status: "ok", version}` |
| `/openapi.json` + `/docs` | Global rule 21; consumers codegen clients; FastAPI gives this for free | LOW | scalar-fastapi at `/docs`; committed `docs/api.md` |
| API key / bearer auth | Internal ≠ unauthenticated; `hyperoptimizedwebsites` and `ottolax` must identify themselves | LOW | Static bearer tokens in Coolify env; no full OAuth needed for internal |
| SSRF protection on submitted URLs | Accepting arbitrary URLs from consumers is a SSRF vector | MEDIUM | Block RFC-1918/link-local/loopback before any outbound fetch; prerequisite to go-live |
| Response-size cap on fetched pages | Unbounded scrape can OOM the container | LOW | Already flagged in CONCERNS.md; ~5 MB hard cap |
| Idempotency / dedup of recent audits | Same URL submitted twice within N minutes wastes a `claude -p` call (expensive) | MEDIUM | Cache by `(url, date)` or content hash; return existing job_id if still fresh (e.g. <1h) |
| Audit history list: `GET /audits?url=&limit=&offset=` | Consumers need to show past scores; ottolax dashboard needs history | MEDIUM | Postgres-backed; pagination required |
| Pagination on list endpoints | Any list endpoint must handle growth | LOW | `limit` + `offset` or cursor; return `total` in envelope |
| Timestamps on all records | Consumers need to know when the score was computed | LOW | `created_at`, `started_at`, `completed_at` — store as UTC in Postgres |

### Differentiators (Internal Value-Adds)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Webhook / callback on completion | Consumer fires-and-forgets; no polling loop needed | MEDIUM | `POST /audits` accepts optional `callback_url`; service POSTs result when done. Requires retry logic (3x with backoff). Needs SSRF protection on callback_url too. |
| Scheduled re-audits (`POST /schedules`) | Track GEO score drift over time without manual triggers | HIGH | Cron container reads a `schedules` table and submits jobs. Depends on: job submission, Postgres, auth. |
| `GET /audits/{job_id}/report` → PDF/HTML | Return the rendered report artifact, not just the JSON score | MEDIUM | Pandoc + headless Chrome already exist; store artifact path in Postgres; serve from volume or signed URL |
| Result caching TTL config per consumer | `hyperoptimizedwebsites` may want 24h freshness; ottolax may want 1h | LOW | Per-API-key `cache_ttl_seconds` config in DB; dedup check respects it |
| Batch submit: `POST /audits/batch` | Submit N URLs in one request; ottolax bulk-crawl use case | MEDIUM | Returns array of job_ids; each runs independently. Depends on: job model, rate limiting. |
| `GET /audits/{job_id}/stream` (SSE) | Consumer gets live progress updates without polling | HIGH | SSE > WebSocket for this (global rule preference); requires in-process progress events from `claude -p` subprocess. Complex given headless claude subprocess. Defer unless polling proves painful. |

### Anti-Features (Deliberately Avoid for Internal Service)

| Feature | Why It Seems Appealing | Why to Avoid | Better Approach |
|---------|----------------------|--------------|-----------------|
| Synchronous audit endpoint (`POST` blocks until done) | Simpler consumer code | Audits take 30-120s; ties up connections; consumer timeouts; no way to retry mid-audit | Async job model is table stakes for this latency profile |
| Self-registration / API key management UI | "Nice admin panel" | Internal service with 2 consumers; admin UI = scope creep; Titanium Licensing wiring is out of scope this milestone | Static bearer tokens in Coolify env; rotate manually |
| Multi-tenant billing / metering | Future-proofing | Explicitly out of scope (PROJECT.md); adds Titanium Licensing complexity prematurely | Revisit if service becomes user-facing |
| Real-time audit progress via WebSocket | Rich progress UX | SSE is simpler + Cloudflare-friendly (global rule); WebSocket needs upgrade + keep-alive management; the `claude -p` subprocess doesn't emit structured progress anyway | Poll `GET /audits/{job_id}` every 5s; add SSE only if polling proves painful |
| Per-consumer result namespacing / data isolation | "Cleaner multi-tenancy" | 2 internal consumers sharing the same audit corpus is fine and reduces duplicate work | Tag results with `source_app` field on the job row |
| Audit queuing SLA / priority lanes | Enterprise feature | Overkill for 2 consumers with low volume | Single FIFO queue via Postgres; add priority only if starvation observed |
| Streaming scrape results to consumer during audit | "Real-time feels" | Scraping and scoring are tightly coupled; partial results are misleading for a 0-100 score | Return complete result only; indicate `running` status during execution |
| GraphQL / gRPC endpoint | "Flexible querying" | 2 internal consumers; REST + OpenAPI codegen is sufficient; adds maintenance burden | REST with full OpenAPI spec; consumers codegen typed clients |
| Audit diff / comparison endpoint | Interesting analytics | Premature; no consumer need identified yet | Raw history data in Postgres lets consumers build this themselves |

## Feature Dependencies

```
[API key auth]
    └──required by──> ALL endpoints (prerequisite to go-live)

[Job submission POST /audits]
    └──required by──> [Job status GET /audits/{id}]
    └──required by──> [Audit history GET /audits]
    └──required by──> [Webhook/callback]
    └──required by──> [Batch submit]
    └──required by──> [Scheduled re-audits]

[Postgres persistence]
    └──required by──> [Job status]
    └──required by──> [Audit history + pagination]
    └──required by──> [Dedup/caching]
    └──required by──> [Scheduled re-audits]

[Dedup/caching]
    └──enhances──> [Job submission] (returns existing job_id if fresh)

[SSRF protection]
    └──required by──> [Job submission] (must validate URL before fetch)
    └──required by──> [Webhook/callback] (must validate callback_url before POST)

[Report generation (PDF/HTML)]
    └──required by──> [GET /audits/{id}/report]
    └──depends on──> [Job completion] (report only exists post-completion)

[Batch submit]
    └──depends on──> [Job submission] (calls it N times internally)
    └──depends on──> [Rate limiting] (batch amplifies load)

[Scheduled re-audits]
    └──depends on──> [Job submission]
    └──depends on──> [Postgres persistence] (schedules table)
    └──depends on──> [Separate cron container or APScheduler]
```

### Dependency Notes

- **SSRF protection must ship before job submission goes live** — accepting arbitrary URLs from consumers without it is an unacceptable security risk (PROJECT.md CONCERNS.md both flag this).
- **Postgres must be wired before any stateful feature** — job status, history, dedup, schedules all require it.
- **Dedup/caching enhances job submission** but is not a blocker — can ship job submission without it and add dedup in the next phase.
- **Webhook callback_url requires the same SSRF check as audit URLs** — easy to miss; flag for implementation phase.
- **Scheduled re-audits depend on the most moving parts** — job model + Postgres + cron infra; rightfully a later phase.

## MVP Definition

### Launch With (v1)

Minimum needed for `hyperoptimizedwebsites` and `ottolax` to call the service in production.

- [ ] SSRF protection + response-size cap — security prerequisite; nothing ships without this
- [ ] API key / bearer auth — all endpoints protected
- [ ] `POST /audits` → `{job_id}` with async execution via FastAPI BackgroundTasks
- [ ] `GET /audits/{job_id}` → status + full result (geo_score, findings, timestamps)
- [ ] Structured error schema — consumers must handle failures gracefully
- [ ] Dedup: same URL within 1h returns existing job_id (avoid burning `claude -p` calls)
- [ ] `GET /audits?url=&limit=&offset=` — history list with pagination
- [ ] `/healthz` — Coolify health check
- [ ] `/openapi.json` + `/docs` — global rule 21

### Add After Validation (v1.x)

Add once core job flow is proven in production.

- [ ] Webhook/callback — trigger: consumers find polling inconvenient in practice
- [ ] `GET /audits/{job_id}/report` — trigger: consumers want the PDF artifact, not just JSON
- [ ] Scheduled re-audits — trigger: ottolax needs regular score tracking without manual triggers

### Future Consideration (v2+)

Defer until v2 unless a specific consumer need forces it earlier.

- [ ] Batch submit `POST /audits/batch` — defer until volume justifies it
- [ ] SSE progress stream — defer unless polling latency causes UX complaints
- [ ] Per-consumer cache TTL config — defer; start with a single global TTL

## Feature Prioritization Matrix

| Feature | Consumer Value | Implementation Cost | Priority |
|---------|---------------|---------------------|----------|
| SSRF + size-cap protection | HIGH (security) | MEDIUM | P1 |
| API key auth | HIGH | LOW | P1 |
| POST /audits (async job) | HIGH | MEDIUM | P1 |
| GET /audits/{id} (status/result) | HIGH | LOW | P1 |
| Structured error schema | HIGH | LOW | P1 |
| Dedup/caching | HIGH (cost control) | MEDIUM | P1 |
| GET /audits (history + pagination) | HIGH | MEDIUM | P1 |
| /healthz | HIGH (infra) | LOW | P1 |
| /openapi.json + /docs | HIGH (rule 21) | LOW | P1 |
| Webhook/callback | MEDIUM | MEDIUM | P2 |
| GET /audits/{id}/report | MEDIUM | MEDIUM | P2 |
| Scheduled re-audits | MEDIUM | HIGH | P2 |
| Batch submit | LOW | MEDIUM | P3 |
| SSE progress stream | LOW | HIGH | P3 |
| Per-consumer cache TTL | LOW | LOW | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Sources

- PROJECT.md — validated requirements, constraints, out-of-scope decisions
- .planning/codebase/ARCHITECTURE.md — existing system; consumers; scraping/scoring pipeline
- .planning/codebase/CONCERNS.md — SSRF, response-size, racy JSON writes (informed SSRF as prerequisite)
- Standard async job API patterns (RFC 7231 202 Accepted; poll-until-done; webhook-on-complete)
- Internal consumer context: `../hyperoptimizedwebsites` and `../ottolax` are the only consumers; no public SaaS requirements apply

---
*Feature research for: geo-api async audit-as-a-service HTTP API (internal)*
*Researched: 2026-06-01*
