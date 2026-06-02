# Project Research Summary

**Project:** geo-api
**Domain:** Async audit-as-a-service -- FastAPI wrapping a brownfield Claude Code skill toolkit; headless LLM scoring; Postgres job queue; Coolify deploy
**Researched:** 2026-06-01
**Confidence:** HIGH

## Executive Summary

geo-api is a containerized FastAPI service that turns an interactive markdown-driven Claude Code GEO audit skill into a callable HTTP API. Consumers (hyperoptimizedwebsites, ottolax) POST a URL and receive a job ID; a separate worker process imports the existing scripts/*.py scrapers in-process, then shells out to claude -p for LLM synthesis, persisting the 0-100 GEO Score and findings to Postgres. The architecture is straightforward -- thin HTTP layer, Postgres job queue via SELECT FOR UPDATE SKIP LOCKED, same image two CMD entries for API vs worker -- except for one dependency that dominates everything: the scoring engine must run as claude -p on a Claude subscription inside a Docker container. Until that is proven in a container with no TTY, no other work is meaningful.

Two gating risks must be resolved before any API or job-queue code is written. Risk 1 -- the claude -p headless container spike: auth credentials must survive container restarts via a persistent volume mount (~/.claude/), --dangerously-skip-permissions must be passed or the process hangs silently, and the June 15 2026 billing split means usage draws from a separate Agent SDK credit pool (Pro: 20/mo) that could be exhausted by automated audits. Risk 2 -- SSRF and response-size hardening of scripts/fetch_page.py: the existing fetcher accepts arbitrary URLs with only a scheme check, uses allow_redirects=True without IP re-validation, and loads full response bodies into memory -- all three are exploitable from the /audit endpoint and must be fixed in a shared http.py helper before the endpoint is wired to any network path.

The recommended stack is unambiguous: FastAPI 0.115 + SAQ + psycopg3 (psycopg[binary]>=3.2) + SQLAlchemy 2 Core + Alembic + scalar-fastapi. SAQ (not ARQ, not Celery, not BackgroundTasks) because audits are multi-minute subprocesses that cannot run in the web worker process. psycopg3 because its AsyncConnectionPool is built-in and is the officially supported SQLAlchemy 2 async driver. The job queue is Postgres itself (SKIP LOCKED) -- no Redis broker needed at this volume. BackgroundTasks are explicitly wrong for this workload and must not appear anywhere in the implementation.

## Key Findings

### Recommended Stack

Thin async FastAPI app plus a separate worker process, both from the same Docker image on Coolify. The only novel element is claude -p as a subprocess; everything else is established FastAPI/Postgres async patterns. See .planning/research/STACK.md for full version pins and decision rationale.

**Core technologies:**
- **FastAPI >=0.115,<1.0** -- HTTP API framework; native OpenAPI; Pydantic v2; PROJECT.md constraint
- **SAQ >=0.22** -- async task queue; asyncio-native; ARQ direct successor (ARQ is maintenance-only per GitHub issue #437); do NOT use ARQ, Celery, or BackgroundTasks
- **psycopg3 (psycopg[binary]>=3.2)** -- Postgres async driver; built-in AsyncConnectionPool; official SQLAlchemy 2 async driver; binary wheels = no libpq compile in Docker
- **SQLAlchemy 2 Core + Alembic >=1.14** -- schema management and typed queries; no ORM overhead for 2-3 tables; postgresql+psycopg:// DSN
- **scalar-fastapi ==1.8.2** -- /docs UI; global rule 21 mandatory; pin to latest (Apr 2026)
- **asyncio.create_subprocess_exec** -- claude -p subprocess execution; NEVER subprocess.run() inside async -- blocks event loop
- **asyncio.Semaphore(max_concurrent_audits=2)** -- concurrency cap; prevents OOM and subscription rate exhaustion

**Critical version notes:**
- SAQ requires redis>=5.0 (async client rewrite; v4 incompatible)
- psycopg[binary]>=3.2 requires SQLAlchemy>=2.0.7 (psycopg3 async support added in 2.0.7)

### Expected Features

Internal service with two known consumers. See .planning/research/FEATURES.md for full prioritization matrix.

**Must have (P1 -- v1 launch):**
- SSRF protection + response-size cap on fetch_page.py -- security prerequisite; blocks go-live
- Bearer token auth -- all endpoints; static tokens in Coolify env
- POST /audits returning {job_id, status: queued} (202 Accepted) -- async job model
- GET /audits/{job_id} returning status + result with geo_score, findings, timestamps
- Structured error schema -- {code, message, detail}; never bare 500s
- Dedup: same URL within 1h returns existing job_id (claude -p call cost control)
- GET /audits with url/limit/offset params -- history with pagination
- /healthz -- structured JSON: {status, postgres, claude_auth, worker_alive, queue_depth, active_jobs}
- /openapi.json + /docs (scalar) -- global rule 21

**Should have (P2 -- v1.x after validation):**
- Webhook/callback on completion -- needs SSRF guard on callback_url too
- GET /audits/{job_id}/report -- PDF/HTML from existing pandoc/headless Chrome pipeline
- Scheduled re-audits -- cron container POSTs to /audits on schedule

**Defer (v2+):**
- Batch submit POST /audits/batch
- SSE progress stream (claude -p emits no structured mid-run progress)
- Per-consumer cache TTL config

**Anti-features -- never implement:**
- Synchronous audit endpoint (blocks 30-120s)
- BackgroundTasks for audit execution (jobs lost on redeploy, no retry, no persistence)
- WebSocket (SSE preferred; claude -p has no mid-run progress anyway)

### Architecture Approach

Two Coolify services from one Docker image (API: python -m api.main, Worker: python -m worker.main). Postgres job queue via SELECT FOR UPDATE SKIP LOCKED -- no Redis broker at this volume. Scripts imported in-process (verify no sys.exit at module level before Phase 4). claude -p runs as isolated subprocess with 120s timeout and explicit proc.kill() on timeout/exception. Separate Alpine cron container for scheduled re-audits -- no Python, decoupled from geo-api deploy lifecycle.

**Major components:**
1. **api/** -- FastAPI app: auth middleware, SSRF middleware, POST /audits, GET /audits/{id}, GET /audits, /healthz, /openapi.json; no business logic
2. **worker/** -- SKIP LOCKED job claim, import scripts in-process, asyncio.create_subprocess_exec for claude -p, persist result; Semaphore(2) cap; explicit subprocess kill on timeout
3. **scripts/** -- existing scrapers imported as-is; only SSRF/size-cap hardening via shared http.py helper; no rewrites
4. **db/** -- audit_jobs table; Alembic migrations; AsyncConnectionPool; heartbeat_at column for stuck-job reaper
5. **Postgres** -- state machine: queued -> running -> done / failed; reaper resets jobs where heartbeat_at < NOW() - 10m
6. **Cron container** -- Alpine + curl; no Python; decoupled from geo-api deploy lifecycle

### Critical Pitfalls

Full 11-pitfall catalog with verification tests in .planning/research/PITFALLS.md. Top 5:

1. **claude -p hangs on auth prompt in container** -- de-risk spike MUST run inside a container with no TTY before any other build work; mount ~/.claude/ as persistent volume; always pass --dangerously-skip-permissions; capture stderr and treat any login/browser/auth string as hard failure. Without this solved the entire scoring approach must change.

2. **SSRF via private-IP access through fetch_page.py** -- current code only validates scheme; resolve hostname to IP, reject RFC-1918/link-local/loopback/IPv6-ULA; shared http.py helper applied to ALL scripts; also applies to webhook callback_url and every sitemap loc URL.

3. **DNS rebinding bypass** -- validating hostname then passing it back to requests defeats the SSRF check; pin to resolved IP at socket level via custom urllib3 transport adapter; never validate-then-re-resolve.

4. **Zombie claude processes accumulating** -- documented real incident in this environment (34 orphan claudes = 8 GB); asyncio.wait_for timeout cancels coroutine but does NOT kill child process; always proc.kill() + await proc.wait() in except TimeoutError / finally.

5. **BackgroundTasks job loss and event-loop blocking by sync scrapers** -- BackgroundTasks die on SIGTERM with no persistence; sync requests.get inside async def blocks event loop; use separate worker process with run_in_executor for all script calls.

## Implications for Roadmap

Build order is strictly dependency-driven. Do not reorder.

### Phase 1: claude-p-container-spike
**Rationale:** Single highest-risk unknown. Blocks all other phases. If claude -p cannot be authed inside Docker reliably, the scoring architecture must change -- all downstream work becomes waste.
**Delivers:** Confirmed working invocation in a container; auth persistence validated (full docker stop/start cycle); Agent SDK credit burn rate measured; tests/test_claude_subprocess.py as executable proof.
**Addresses:** Pitfalls 1, 8 (auth hang, auth not persisted across restarts)
**Must validate:** credentials persist through full image replacement; --dangerously-skip-permissions works; June 15 billing split understood; stderr auth-prompt detection confirmed.
**Research flag:** NEEDS SPIKE -- claude -p in container not well-documented; auth token TTL unknown; Agent SDK billing behavior in automated contexts is new (June 15 2026 change). If Phase 1 fails, escalate immediately; do not proceed.

### Phase 2: ssrf-and-fetch-hardening
**Rationale:** Security prerequisite. Cannot expose /audit to any consumer until all scripts calling requests.get are guarded. Also closes decompression-bomb OOM risk.
**Delivers:** Shared http.py helper with DNS-pinning SSRF guard, 3-hop redirect re-validation, 5 MB response cap, stream-read pattern; applied to all scripts; sitemap loc URLs guarded; pytest: POST /audit with RFC-1918 URL returns 400.
**Addresses:** Pitfalls 2, 3, 4 (SSRF, decompression bomb, DNS rebinding)
**Research flag:** Standard patterns -- no additional research needed.

### Phase 3: postgres-schema-and-job-queue
**Rationale:** Both API and worker need the DB layer. heartbeat_at reaper design must be decided here, not retrofitted.
**Delivers:** audit_jobs migration (Alembic); db/queries.py with claim_job, update_job, get_job, list_jobs; heartbeat_at + reaper; SKIP LOCKED multi-worker safety tested via docker-compose.
**Addresses:** Pitfalls 5, 10 (BackgroundTasks job loss -- schema prevents it by design; stuck-job reaper)
**Research flag:** Standard patterns.

### Phase 4: worker-pipeline
**Rationale:** Core value delivery. Needs Phases 1-3. Prove worker in isolation before wiring HTTP.
**Delivers:** worker/runner.py end-to-end: claim job, import scripts in-process, asyncio.create_subprocess_exec for claude -p, persist result; Semaphore(2) cap; proc.kill() on timeout; heartbeat_at updates; integration test with real URL.
**Addresses:** Pitfalls 6, 7, 9 (event-loop blocking, concurrency cap, zombie processes)
**Research flag:** Standard patterns once Phase 1 spike confirmed.

### Phase 5: fastapi-api-layer
**Rationale:** Thin HTTP envelope over DB. Worker pipeline proven first. Fast phase once DB and worker exist.
**Delivers:** POST /audits, GET /audits/{id}, GET /audits, auth middleware, SSRF middleware (reuses http.py), dedup (1h TTL), /healthz with all dependency checks, /openapi.json, scalar /docs, docs/api.md committed.
**Addresses:** Pitfall 10 (shallow health check)
**Research flag:** Standard patterns.

### Phase 6: containerization-and-coolify-deploy
**Rationale:** Phases 4+5 working locally is prerequisite.
**Delivers:** Dockerfile (non-root appuser, ~/.claude volume mount, no secrets in layers); docker-compose.yml; Coolify service configs (API + Worker); startup probe (/healthz with claude_auth: true); smoke-test script (POST -> poll -> verify score 0-100); docker history clean.
**Addresses:** Pitfalls 8, 11 (auth not persisted, secrets in layers)
**Research flag:** Standard patterns.

### Phase 7: cron-container-and-consumer-wiring
**Rationale:** Requires live deployed API from Phase 6.
**Delivers:** Cron Dockerfile (Alpine + curl); schedule config; hyperoptimizedwebsites + ottolax integration (bearer tokens in Coolify envs); end-to-end consumer test.
**Research flag:** Standard patterns.

### Phase Ordering Rationale

- Phase 1 before everything: claude -p spike is the only genuine unknown; all other phases use established patterns
- Phase 2 before Phase 5: SSRF guard built in http.py (Phase 2) reused as FastAPI middleware (Phase 5)
- Phase 3 before Phases 4+5: both depend on DB schema; retrofitting heartbeat_at after worker is built is a rewrite
- Phase 4 before Phase 5: prove worker pipeline before wrapping in HTTP; easier to debug without HTTP layer
- Phase 6 before Phase 7: cron container needs a live endpoint to POST to

### Research Flags

**Needs spike:**
- **Phase 1 (claude-p-container-spike)** -- auth token TTL, Agent SDK credit pool under automated load, --dangerously-skip-permissions in non-interactive containers. If Phase 1 fails, escalate immediately; do not proceed.

**Standard patterns (research-phase not needed):**
- Phases 2-7: SSRF guards, Postgres SKIP LOCKED, SAQ, FastAPI middleware, Dockerfile patterns, Coolify volumes all have official docs and well-established patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Official docs + verified PyPI; ARQ deprecation confirmed GitHub issue; psycopg3 SQLAlchemy 2 support verified in changelog |
| Features | HIGH | Internal service; consumers known; no market ambiguity; feature set from PROJECT.md + CONCERNS.md |
| Architecture | HIGH | Inferred from existing codebase map + production-proven Postgres SKIP LOCKED patterns |
| Pitfalls | HIGH | Grounded in CONCERNS.md codebase audit + documented real-world incidents in this environment |

**Overall confidence:** HIGH

### Gaps to Address

- **claude -p auth token TTL:** Unknown if subscription OAuth tokens are long-lived in containers; validate in Phase 1. If tokens require interactive browser re-auth on expiry, the container strategy needs a re-auth mechanism.
- **Agent SDK credit burn rate:** 20/mo Pro pool may be exhausted in hours of automated audit load. Measure in Phase 1 before committing to subscription-based scoring at any meaningful volume.
- **scripts/*.py import-guard safety:** Verify no sys.exit() at module level with grep across all scripts as first task of Phase 4 before importing anything in the worker.
- **SAQ vs pure Postgres queue tension:** STACK.md recommends SAQ (Redis-backed), ARCHITECTURE.md recommends pure Postgres SKIP LOCKED (no Redis). At tens of jobs/hour, Postgres-only is simpler and eliminates one Coolify service. Roadmapper must decide: SAQ worker loop with Postgres queue, or hand-rolled asyncio worker. Pick one explicitly.

## Sources

### Primary (HIGH confidence)
- .planning/codebase/CONCERNS.md -- direct codebase evidence for SSRF, response-size, blocking I/O
- .planning/PROJECT.md -- validated requirements, constraints, out-of-scope decisions
- Claude Code headless docs (code.claude.com/docs/en/headless) -- -p flag, --output-format json, --dangerously-skip-permissions
- Claude Agent SDK credit pool (support.claude.com) -- June 15 2026 billing split confirmed
- ARQ maintenance-only (github.com/python-arq/arq/issues/437) -- confirmed no active development
- scalar-fastapi PyPI -- v1.8.2 confirmed Apr 9 2026
- Global rule 23 in ~/.claude/CLAUDE.md -- real incident: 34 orphan claudes + 90 uv/uvx = 8 GB

### Secondary (MEDIUM confidence)
- GitHub issue #22066 -- OAuth not persisting in Docker; credential mount gotcha
- Community notes on Claude credential persistence -- both ~/.claude/.credentials.json + ~/.claude.json required
- psycopg3 vs asyncpg benchmarks -- performance delta irrelevant at this volume

### Tertiary (LOW confidence -- validate in Phase 1)
- Agent SDK credit pool behavior under automated concurrent audit load -- inferred; actual burn rate unverified
- OAuth token TTL for subscription accounts in non-interactive containers -- not documented; must be empirically tested

---
*Research completed: 2026-06-01*
*Ready for roadmap: yes*
