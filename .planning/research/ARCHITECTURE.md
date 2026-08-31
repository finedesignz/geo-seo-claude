# Architecture Research

**Domain:** Async audit service wrapping a brownfield Claude Code skill toolkit
**Researched:** 2026-06-01
**Confidence:** HIGH (inferred directly from existing codebase + established FastAPI/Postgres patterns)

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          TRIGGER LAYER                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────┐   │
│  │  HTTP consumers   │  │  Cron container   │  │  Direct HTTP POST │   │
│  │ (hyperoptimized,  │  │  (scheduled re-   │  │  /audit (dev/ops) │   │
│  │  ottolax)         │  │   audits)         │  │                  │   │
│  └────────┬─────────┘  └────────┬──────────┘  └────────┬──────────┘   │
│           │   POST /audit        │   POST /audit         │             │
└───────────┼──────────────────────┼───────────────────────┼─────────────┘
            │                      │                       │
            ▼                      ▼                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          API LAYER  (FastAPI)                         │
│                                                                       │
│  POST /audit → enqueue job → return {job_id}                          │
│  GET  /audit/{job_id} → return status + result                        │
│  GET  /openapi.json   · GET /docs (scalar)                            │
│                                                                       │
│  Auth middleware: bearer token (all routes)                           │
│  SSRF guard: validate URL before enqueue                              │
└──────────────────────────────┬───────────────────────────────────────┘
                               │  write job row (queued)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       POSTGRES  (Coolify)                             │
│                                                                       │
│  audit_jobs: id, url, status, created_at, started_at, finished_at,   │
│              score, findings_json, error                              │
└──────────────────────────────┬───────────────────────────────────────┘
                               │  LISTEN / poll
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       WORKER  (same image, separate process)          │
│                                                                       │
│  Loop: claim next queued job (SELECT ... FOR UPDATE SKIP LOCKED)      │
│        mark running                                                    │
│        run audit pipeline                                              │
│        mark done / failed                                              │
│                                                                       │
│  Audit pipeline:                                                       │
│  ┌─────────────────────────────────────────────────────────────┐      │
│  │  1. import scripts.fetch_page   → page_data (in-process)    │      │
│  │  2. import scripts.brand_scanner → brand_data (in-process)  │      │
│  │  3. import scripts.citability_scorer → cit_data (in-proc)   │      │
│  │  4. subprocess: claude -p <synthesis_prompt>  → score+JSON  │      │
│  │     (timeout 120s, kill on exceed)                           │      │
│  └─────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Boundary |
|-----------|---------------|---------|
| FastAPI app (`api/`) | Accept HTTP, validate input (SSRF guard), enqueue jobs, serve status/results, auth | No business logic; never calls scripts directly |
| Worker process (`worker/`) | Claim jobs, run pipeline, persist results | Single concern: audit execution loop |
| scripts/*.py (existing) | Deterministic fetch/score/scan, JSON out | Imported in-process; no HTTP; no DB access |
| `claude -p` subprocess | LLM synthesis: aggregate sub-scores → 0-100 GEO score + findings narrative | Subprocess only; isolated via timeout + kill; no direct Python import possible |
| Postgres (`audit_jobs` table) | Job state machine, durable result storage, concurrency-safe queue via SKIP LOCKED | Shared by API + worker; never accessed from scripts |
| Cron container (separate image) | Scheduled POST /audit calls; no business logic | Treats geo-api as external service via HTTP |

## Recommended Project Structure

```
geo-api/
├── api/
│   ├── main.py              # FastAPI app, router mounts, lifespan
│   ├── routes/
│   │   └── audit.py         # POST /audit, GET /audit/{id}
│   ├── middleware/
│   │   ├── auth.py          # bearer token check
│   │   └── ssrf.py          # URL validation, private-IP block, size cap
│   └── schemas.py           # Pydantic request/response models
├── worker/
│   ├── main.py              # entry point: run loop or single-shot
│   └── runner.py            # audit pipeline: scripts import + claude -p subprocess
├── db/
│   ├── connection.py        # asyncpg pool init
│   ├── migrations/          # SQL migration files (numbered)
│   └── queries.py           # typed query functions (no ORM needed at this scale)
├── scripts/                 # symlink or copy of geo-seo-claude/scripts/
│   ├── fetch_page.py
│   ├── citability_scorer.py
│   ├── brand_scanner.py
│   └── llmstxt_generator.py
├── prompts/
│   └── synthesis.md         # claude -p input template (url + raw tool outputs → score)
├── tests/
│   ├── test_ssrf.py
│   ├── test_worker_pipeline.py
│   └── test_claude_subprocess.py   # de-risk spike test lives here
├── docs/                    # rule 21: committed API docs
│   └── api.md
├── Dockerfile
├── docker-compose.yml       # local: api + worker + postgres
├── requirements.txt
├── README.md
└── CLAUDE.md
```

### Structure Rationale

- **api/ vs worker/**: separate entry points allow `CMD ["python", "-m", "api.main"]` vs `CMD ["python", "-m", "worker.main"]` in Coolify — same image, two services.
- **db/queries.py**: raw asyncpg queries with SKIP LOCKED (no SQLAlchemy ORM needed; adds complexity for 1 table).
- **scripts/**: brought in as a directory copy/symlink; no rewrite; pip deps shared via same requirements.txt.
- **prompts/synthesis.md**: the claude -p input is a markdown template rendered with audit tool outputs; keeping it in a file makes it tunable without code changes.
- **Cron container**: separate lightweight image (alpine + curl/httpie) with a simple shell loop; never imports Python; just POSTs to the API on schedule.

## Architectural Patterns

### Pattern 1: SELECT FOR UPDATE SKIP LOCKED job queue

**What:** Use Postgres itself as the job queue. Workers atomically claim a row, preventing double-processing without external queue infra (no Redis, no Celery, no RQ).
**When to use:** Low-to-medium throughput (< ~100 concurrent audits), want zero extra infra.
**Trade-offs:** No retry backoff out of box (add `attempt_count` + `next_retry_at`); no dead-letter queue (add `failed` status + error column); Postgres must be reachable from worker — fine since both are on Coolify.

```sql
-- Worker claims one job atomically
BEGIN;
SELECT id, url FROM audit_jobs
WHERE status = 'queued'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;

UPDATE audit_jobs SET status = 'running', started_at = now() WHERE id = $1;
COMMIT;
```

### Pattern 2: scripts imported in-process, claude -p as isolated subprocess

**What:** Import `scripts/fetch_page.py`, `scripts/brand_scanner.py`, `scripts/citability_scorer.py` directly into the worker Python process (they are stateless, pure-function CLIs; importing them is safe). The LLM synthesis step — which *requires* a Claude session — runs as `subprocess.run(["claude", "-p", ...], input=prompt, timeout=120, capture_output=True)`.
**When to use:** Always, for this project. Scripts have no server-incompatible side effects (no `sys.exit` at module level after import-guard fix). Subprocess isolation for claude -p is mandatory: it can hang, crash, or produce oversized output; a subprocess with `timeout` + `kill` provides a clean blast radius.
**Trade-offs:** In-process import means a script crash raises in the worker (handle with try/except per-step); subprocess means one more OS process per audit (fine — audits are serial per worker instance).

```python
# worker/runner.py (simplified)
import asyncio, subprocess, json
from scripts.fetch_page import fetch_page
from scripts.citability_scorer import score_passages
from scripts.brand_scanner import scan_brand

async def run_audit(url: str) -> dict:
    page = fetch_page(url)                     # in-process
    cit  = score_passages(page["content"])     # in-process
    brand = scan_brand(url)                    # in-process

    prompt = render_synthesis_prompt(url, page, cit, brand)
    result = subprocess.run(
        ["claude", "-p"],
        input=prompt, text=True,
        capture_output=True, timeout=120
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude -p failed: {result.stderr[:500]}")
    return json.loads(result.stdout)
```

### Pattern 3: Shared /audit endpoint — cron and event consumers are identical callers

**What:** Both the cron container and sibling app consumers send `POST /audit {url}` and optionally poll `GET /audit/{job_id}`. The API has no concept of "who triggered this." The cron container is just another authenticated HTTP client.
**When to use:** Always. Centralizes all trigger logic in one code path; cron container becomes a 5-line shell script.
**Trade-offs:** Cron container must store/know the bearer token (Coolify env var); consumers must handle async polling (or use a webhook callback URL if added later).

## Data Flow

### POST /audit → stored result

```
Consumer/Cron  →  POST /audit {url, callback_url?}
                      ↓
               [auth middleware]  →  401 if bad token
                      ↓
               [ssrf middleware]  →  422 if private IP / bad URL
                      ↓
               INSERT audit_jobs (status=queued)  →  Postgres
                      ↓
               return {job_id, status: "queued"}  →  Consumer

                  (async, in worker process)
                      ↓
               SELECT ... FOR UPDATE SKIP LOCKED  ←  Postgres
                      ↓
               UPDATE status=running
                      ↓
               fetch_page(url)           ←  scripts/fetch_page.py (in-process)
                      ↓
               scan_brand(url)           ←  scripts/brand_scanner.py (in-process)
                      ↓
               score_passages(content)   ←  scripts/citability_scorer.py (in-process)
                      ↓
               render synthesis prompt
                      ↓
               subprocess: claude -p     ←  local Claude subscription
               (timeout=120s)
                      ↓ stdout JSON
               UPDATE status=done, score=N, findings_json=...  →  Postgres

Consumer  →  GET /audit/{job_id}
                      ↓
               SELECT FROM audit_jobs  ←  Postgres
                      ↓
               return {status, score, findings}  →  Consumer
```

### Job State Machine

```
queued → running → done
                 → failed   (worker exception or claude -p timeout/non-zero exit)
```

State transitions are atomic Postgres UPDATEs. No state skips. `failed` rows retain `error` text for debugging. Retry = re-insert as new `queued` row (keep history).

## Container Topology on Coolify

**Single Docker image, two Coolify services:**

```
geo-api image (same build)
├── Service A: API
│   CMD: python -m api.main
│   PORT: 8000
│   REPLICAS: 1 (scale to 2+ if needed)
│   ENV: DATABASE_URL, API_BEARER_TOKEN, CLAUDE_PATH
│
└── Service B: Worker
    CMD: python -m worker.main
    PORT: none
    REPLICAS: 1 (scale = concurrency; SKIP LOCKED is multi-worker safe)
    ENV: same DATABASE_URL, CLAUDE_PATH

Cron container (separate minimal image — alpine + curl)
    ENV: GEO_API_URL, GEO_API_TOKEN, AUDIT_URLS (comma-separated)
    CMD: crond -f (runs /etc/cron.d/geo-audit on schedule)
```

**Rationale for single image:** scripts dependencies, prompts, and requirements.txt are shared. Building two images for API vs worker doubles maintenance. The CMD switch is enough. Worker has no open port so Coolify health checks on the API service only.

**Why cron is separate:** cron container has zero Python; it just `curl -X POST`. Decoupled from geo-api deploy lifecycle. Can be rebuilt/restarted independently without touching the audit service.

## Build Order / Dependency Ordering

This is the correct phase sequence — each phase's output is a prerequisite for the next:

### Phase 1: claude -p de-risk spike (EARLIEST — blocks everything)
**Dependency:** nothing
**Output:** confirmed that `subprocess.run(["claude", "-p"], ...)` works inside a Docker container using the local subscription; know the auth mechanism (session files, env vars, socket?); know timeout characteristics.
**Why first:** if this fails, the entire project's scoring approach must change. No other work is meaningful until this is proven. Build the spike as `tests/test_claude_subprocess.py` before writing any API code.

### Phase 2: SSRF hardening of fetch_page.py
**Dependency:** existing `scripts/fetch_page.py`
**Output:** hardened fetcher with private-IP blocklist, redirect validation, response-size cap; pytest coverage.
**Why second:** security prerequisite before the URL is accepted via HTTP. Can't open `/audit` to consumers until this is done.

### Phase 3: Postgres schema + job queue
**Dependency:** Coolify Postgres provisioned
**Output:** `audit_jobs` table migration, `db/queries.py` (claim/update/select), tested locally with docker-compose.
**Why third:** API and worker both need the DB layer; must exist before either can be built.

### Phase 4: Worker pipeline (scripts import + claude -p subprocess)
**Dependency:** Phase 1 (claude -p proven), Phase 2 (hardened fetcher), Phase 3 (DB)
**Output:** `worker/runner.py` end-to-end: claims job, runs scripts in-process, calls claude -p, persists result.
**Why fourth:** the core value delivery; needs all prior pieces.

### Phase 5: FastAPI API layer
**Dependency:** Phase 3 (DB), Phase 4 (understand job model from worker)
**Output:** `POST /audit`, `GET /audit/{id}`, auth middleware, SSRF middleware, `/openapi.json`, `/docs`.
**Why fifth:** API is a thin envelope over the DB; worker pipeline correctness should be proven before wiring the HTTP surface.

### Phase 6: Containerization + Coolify deploy
**Dependency:** Phase 4 + 5 working locally
**Output:** Dockerfile, docker-compose for local dev, Coolify service configs (API + Worker), smoke test.

### Phase 7: Cron container + event-driven consumer wiring
**Dependency:** Phase 6 (deployed API endpoint live)
**Output:** cron Dockerfile + schedule config; `hyperoptimizedwebsites` / `ottolax` integration (POST /audit calls).

## Anti-Patterns

### Anti-Pattern 1: Rewriting scripts as class methods / service methods

**What people do:** refactor `fetch_page.py` into a `PageFetcher` class inside the worker service.
**Why it's wrong:** the scripts are the existing working implementation; any rewrite risks regressions; the in-process import of a stateless function is already the right abstraction.
**Do this instead:** import the module-level function directly. Fix only the SSRF issues (Phase 2), nothing else.

### Anti-Pattern 2: Using FastAPI BackgroundTasks for audit execution

**What people do:** `background_tasks.add_task(run_audit, url)` inside the POST handler — no separate worker process.
**Why it's wrong:** BackgroundTasks run in the same asyncio event loop as the web server. A blocking `subprocess.run(["claude", "-p"])` with a 2-minute timeout will starve the event loop, blocking all other requests. Scripts also make synchronous HTTP calls.
**Do this instead:** separate worker process polling Postgres with SKIP LOCKED. The API only writes the job row and returns.

### Anti-Pattern 3: Passing the full HTML/page content to claude -p via a giant stdin prompt

**What people do:** dump the entire scraped page (can be megabytes) into the synthesis prompt.
**Why it's wrong:** claude -p context limits; slow; expensive.
**Do this instead:** pass the *structured JSON outputs* of the tool scripts (scores, extracted fields, brand mentions) — these are already compact. The synthesis prompt consumes tool outputs, not raw HTML.

### Anti-Pattern 4: One Coolify service with both API + Worker in the same process

**What people do:** run worker threads alongside the FastAPI app in the same container entry point.
**Why it's wrong:** can't scale API replicas independently from workers; a crashed worker takes down the API; mixing web I/O and heavy subprocesses in one process makes resource limits unpredictable.
**Do this instead:** two Coolify services from the same image, different CMD.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Claude CLI (`claude -p`) | subprocess.run, stdin prompt, stdout JSON, timeout 120s | Auth via local session — de-risk spike (Phase 1) must confirm container auth mechanism |
| Coolify Postgres | asyncpg pool, DATABASE_URL from Coolify env | Never in repo; `audit_jobs` table only |
| hyperoptimizedwebsites | HTTP POST /audit + GET /audit/{id} polling | Needs API_BEARER_TOKEN in their env |
| ottolax | Same POST/GET pattern | Same token |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| API ↔ Worker | Postgres `audit_jobs` table (no direct RPC) | Decoupled; worker can restart without losing queued jobs |
| Worker ↔ scripts | Python import (in-process function call) | Scripts must not call `sys.exit()` at module load — fix if needed |
| Worker ↔ claude -p | subprocess stdin/stdout | One subprocess per audit; kill on timeout |
| Cron ↔ API | HTTP POST (bearer auth) | Cron has no Python; pure HTTP client |

## Sources

- Existing codebase: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`
- Project constraints: `.planning/PROJECT.md`
- Postgres SKIP LOCKED pattern: standard PostgreSQL advisory locking for job queues (HIGH confidence, well-established)
- FastAPI subprocess isolation: standard Python async/subprocess pattern (HIGH confidence)

---
*Architecture research for: geo-api async audit service*
*Researched: 2026-06-01*
