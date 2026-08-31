# Stack Research

**Domain:** FastAPI service wrapping Python CLI toolkit — async job execution, headless `claude -p`, Postgres persistence
**Researched:** 2026-06-01
**Confidence:** HIGH (official docs + multiple verified sources)

---

## Context: What This Covers

This file covers ONLY the new `geo-api` service layer. The existing `geo-seo-claude` scraper/audit toolkit stack (requests, BS4, Flask, Playwright, Pillow, validators, rich) is documented in `.planning/codebase/STACK.md` and is NOT duplicated here.

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| FastAPI | `>=0.115,<1.0` | HTTP API framework | Chosen (PROJECT.md constraint). Native OpenAPI + Pydantic; async-first; no further debate needed. |
| Uvicorn | `>=0.34` | ASGI server | Standard FastAPI server; supports `--workers` for prod; pairs cleanly with Gunicorn in containers. |
| Pydantic v2 | `>=2.9` | Request/response models + validation | Ships with FastAPI 0.100+; v2 is Rust-core, ~5-17x faster validation than v1; no reason to pin to v1. |
| SAQ | `>=0.22` | Async task queue (job execution) | See decision rationale below. Redis-backed, asyncio-native, sub-5ms dispatch latency. |
| Redis | `>=7.2` | SAQ broker + job state store | SAQ's only broker option; also doubles as result cache if needed. One container on Coolify. |
| psycopg3 (`psycopg[binary]`) | `>=3.2` | Postgres async driver | See rationale below. Fewer deps than asyncpg, built-in connection pooling (`AsyncConnectionPool`), works with SQLAlchemy 2 ORM if desired. |
| scalar-fastapi | `==1.8.2` | `/docs` UI replacing Swagger | Per global rule 21. Drop-in; latest release Apr 9 2026. Mount at `/docs`, `/openapi.json` stays on FastAPI default. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `python-dotenv` | `>=1.0` | Load `.env` in dev | Dev only; prod env comes from Coolify env vars. |
| `httpx` | `>=0.27` | Async HTTP for inter-service calls | When geo-api calls ottolax/hyperoptimizedwebsites callbacks; also used in FastAPI TestClient async mode. |
| `pytest-asyncio` | `>=0.24` | Async test support | Required for testing async routes + SAQ task functions. |
| `pytest` | `>=8.0` | Test runner | Standard. |
| `alembic` | `>=1.14` | DB migrations | Schema-versioned migrations for the jobs/results tables; run at container start or as init job. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `uv` | Venv + fast installs | Already preferred by existing installer; use for geo-api too. `uv pip install -r requirements.txt`. |
| Docker + Compose | Local dev container parity | Build locally with the same Dockerfile used in Coolify; catches auth-mount issues early. |
| `ruff` | Linting + formatting | Replaces flake8+black in one tool; fast, zero config. |

---

## Decision: Async Job Queue — SAQ over ARQ

**Use SAQ, not ARQ.**

ARQ is **in maintenance-only mode** (no active development, confirmed GitHub issue #437). SAQ is the direct spiritual successor: same asyncio + Redis design, but uses `BLMOVE`/`RPOPLPUSH` + Postgres `NOTIFY` instead of polling, giving <5ms dispatch latency vs ARQ's 0.5s poll interval.

**Why not FastAPI `BackgroundTasks`:** Runs inside the Uvicorn worker process. An audit that calls `claude -p` (subprocess, tens of seconds to minutes) will tie up that worker slot. Under concurrent requests this causes request starvation. No retry, no persistence, no status tracking — jobs lost on restart. Not viable for this workload.

**Why not Celery:** Celery is synchronous-core with async bolted on via `gevent`/`eventlet`; complex config; heavyweight for a single-service use case. SAQ gives 90% of Celery's reliability at 10% of the complexity.

**Why not Dramatiq:** Sync-first, similar complexity penalty to Celery, no asyncio-native support.

**SAQ worker deployment:** separate container (`CMD ["python", "-m", "saq", "worker.settings"]`) sharing the same Redis. Both containers share the Postgres `DATABASE_URL` for writing job results.

---

## Decision: Postgres Driver — psycopg3 over asyncpg

**Use `psycopg[binary]>=3.2` (psycopg3).**

For this project's workload (a small jobs/results store, low-throughput, not a high-TPS OLTP system) the driver performance delta is irrelevant. The decision is driven by operational factors:

- **Built-in `AsyncConnectionPool`** — no need for `asyncpg` + `pgbouncer` config; pool is managed in-process.
- **SQLAlchemy 2 async compatibility** — psycopg3 is the officially supported async driver for SQLAlchemy 2.0+ (`create_async_engine("postgresql+psycopg://...")`). If the team wants ORM-style query building for migrations/models, it just works.
- **Binary wheels** (`psycopg[binary]`) — no libpq compile step in Docker; faster builds.
- asyncpg is faster at raw throughput (up to 10K TPS in benchmarks), but that's irrelevant for an audit service doing tens of jobs per hour at most.

**Schema approach:** Plain SQLAlchemy 2 Core (not ORM) + Alembic for migrations. No heavy ORM abstractions over 2-3 tables.

---

## The #1 Technical Risk: `claude -p` Headless in Container

This is the project's critical path. Every other stack decision is straightforward; this one is not.

### What works (HIGH confidence, official docs + GitHub issues)

**Invocation pattern:**
```python
import asyncio, json, subprocess

async def run_claude_headless(prompt: str) -> dict:
    proc = await asyncio.create_subprocess_exec(
        "claude", "-p", prompt,
        "--output-format", "json",
        "--dangerously-skip-permissions",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed: {stderr.decode()}")
    return json.loads(stdout.decode())
```

Key flags:
- `-p` / `--print` — non-interactive, read stdin/prompt, print to stdout and exit
- `--output-format json` — structured JSON output; includes `result`, `total_cost_usd`, model breakdown
- `--dangerously-skip-permissions` — **required for automation**; without it the process hangs silently waiting for interactive approval

**Do NOT use `subprocess.run()`** for long-running `claude -p` calls inside an `async def` task. It blocks the event loop. Use `asyncio.create_subprocess_exec()`.

### Auth: credential persistence in Docker (MEDIUM confidence — community + GitHub issues)

Claude Code stores credentials in **two locations**:
1. `~/.claude/.credentials.json` — OAuth token (the auth secret)
2. `~/.claude.json` — onboarding/settings state (must exist to skip interactive setup)

Both must be present or the process will hang on first-run interactive prompts.

**Docker credential strategy:**

```dockerfile
# Dockerfile
# claude is installed at /usr/local/bin/claude (or wherever npm global lands)
# Run as non-root user 'appuser' with home /home/appuser
RUN useradd -m appuser
USER appuser
```

```yaml
# docker-compose.yml (dev) / Coolify volume mounts (prod)
volumes:
  - claude-credentials:/home/appuser/.claude   # contains .credentials.json
  - ./claude-dot-json:/home/appuser/.claude.json:ro  # minimal onboarding skip
```

Minimal `~/.claude.json` to skip onboarding (prevents interactive hang):
```json
{"hasCompletedOnboarding": true, "primaryApiKey": null}
```

**Coolify prod:** mount a persistent volume at `/home/appuser/.claude`. On first deploy, manually `docker exec` into the container and run `claude login` once to populate `.credentials.json`. The volume persists it across redeploys. Do NOT bake credentials into the image.

**Known bug (GitHub issue #22066):** OAuth tokens can fail to persist across container restarts if the `.claude` directory is a bind-mount with wrong permissions. Fix: ensure the mount is owned by the container's appuser UID, not root.

### Billing change: June 15, 2026 (HIGH confidence — official support article)

Starting **June 15, 2026**, `claude -p` usage on subscription plans draws from a **separate monthly Agent SDK credit pool**, not the interactive usage quota:
- Pro: $20/mo credit
- Max 5x: $100/mo credit  
- Max 20x: $200/mo credit

Credits are **per-user, non-poolable, non-rollover**. For a service doing automated audits, this credit pool will be consumed faster than interactive use. The de-risk spike must include a credit consumption test under realistic audit load.

### What to spike first

Before building the full service, validate this in isolation:
1. Build a minimal Docker image with `claude` CLI installed and credentials mounted
2. Run `claude -p "Return the number 42 as JSON: {\"score\": 42}" --output-format json --dangerously-skip-permissions`
3. Confirm JSON output parsed correctly
4. Run a real GEO audit prompt (< 1 min)
5. Check credit consumption in Anthropic dashboard

If the spike fails (auth not persisting, subscription not recognized, credits exhausted too fast), the fallback is an Anthropic API key — but that changes the cost model and is explicitly out of scope per PROJECT.md.

---

## Installation

```bash
# Core service dependencies
uv pip install \
  "fastapi>=0.115,<1.0" \
  "uvicorn[standard]>=0.34" \
  "saq>=0.22" \
  "redis>=5.0" \
  "psycopg[binary]>=3.2" \
  "scalar-fastapi==1.8.2" \
  "alembic>=1.14" \
  "python-dotenv>=1.0" \
  "httpx>=0.27"

# Dev / test
uv pip install \
  "pytest>=8.0" \
  "pytest-asyncio>=0.24" \
  "ruff>=0.5" \
  "httpx>=0.27"  # also TestClient dep
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| SAQ | ARQ | Never for new projects — ARQ is maintenance-only. SAQ is the direct replacement. |
| SAQ | Celery | Only if you need multi-language workers, complex routing, or Celery Beat scheduling at scale. Not warranted here. |
| SAQ | FastAPI BackgroundTasks | Only for sub-second fire-and-forget (email send, cache invalidation). Never for subprocess-based jobs. |
| SAQ | Taskiq | Valid alternative, more config overhead; SAQ's simplicity wins for a small queue. |
| psycopg3 | asyncpg | Only if benchmarks show psycopg3 is a bottleneck at scale (very unlikely for this workload). asyncpg requires `pgbouncer` for prod pooling. |
| psycopg3 | SQLAlchemy 2 + asyncpg | SQLAlchemy ORM is fine too; just use `psycopg3` as the driver underneath (`postgresql+psycopg://`). |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `FastAPI.BackgroundTasks` for audits | Runs in web worker process; subprocess that takes minutes blocks request slots; no retry, no persistence, lost on restart | SAQ with Redis |
| `ARQ` | Officially maintenance-only as of 2025 (GitHub issue #437); no new features, will accumulate unpatched bugs | SAQ |
| `Celery` | Sync-core, complex config, `gevent`/`eventlet` hacks for async; overkill for single-service queue | SAQ |
| `asyncpg` direct (no SQLAlchemy) | Requires manual connection pool management + pgbouncer in prod; more boilerplate for same result | `psycopg[binary]` with `AsyncConnectionPool` |
| `psycopg2` | Sync-only; blocks asyncio event loop; technically works in threads but adds complexity | `psycopg[binary]>=3.2` |
| `subprocess.run()` in async task | Blocks event loop during `claude -p` execution (tens of seconds) | `asyncio.create_subprocess_exec()` |
| `ANTHROPIC_API_KEY` for scoring | Explicit out-of-scope decision (PROJECT.md); per-call API cost vs subscription | `claude -p` on subscription via mounted credentials |
| Baking credentials into Docker image | Security violation; credentials visible in layer history | Named Docker volume mounted at `~/.claude` |
| Omitting `--dangerously-skip-permissions` | Process hangs silently waiting for interactive approval; hardest bug to diagnose | Always include the flag in automation |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `fastapi>=0.115` | `pydantic>=2.9` | FastAPI 0.100+ requires Pydantic v2; v1 compat shim exists but don't use it |
| `psycopg[binary]>=3.2` | `SQLAlchemy>=2.0.7` | SQLAlchemy 2.0.7+ added psycopg3 async support via `postgresql+psycopg://` |
| `alembic>=1.14` | `SQLAlchemy>=2.0` | Alembic 1.13+ has async migration support via `run_async_migrations()` |
| `saq>=0.22` | `redis>=5.0` | SAQ requires redis-py v5+ (async client rewrite); v4 is incompatible |
| `scalar-fastapi==1.8.2` | `fastapi>=0.100` | Pin to 1.8.2 (latest, Apr 2026); minor updates are backwards-compatible |

---

## Sources

- [FastAPI official docs — BackgroundTasks](https://fastapi.tiangolo.com/tutorial/background-tasks/) — confirmed limitations
- [ARQ maintenance-only status](https://github.com/python-arq/arq/issues/437) — confirmed no active development
- [SAQ GitHub](https://github.com/python-arq/arq) / PyPI — confirmed <5ms latency, asyncio-native, ARQ replacement
- [psycopg3 vs asyncpg analysis](https://fernandoarteaga.dev/blog/psycopg-vs-asyncpg/) — MEDIUM confidence (community benchmarks)
- [scalar-fastapi PyPI](https://pypi.org/project/scalar-fastapi/) — version 1.8.2 confirmed, Apr 9 2026
- [Claude Code headless docs](https://code.claude.com/docs/en/headless) — `-p`, `--output-format json`, `--dangerously-skip-permissions` flags
- [Claude subscription Agent SDK credits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) — June 15 2026 billing split, credit amounts
- [GitHub issue #22066 — OAuth not persisting in Docker](https://github.com/anthropics/claude-code/issues/22066) — credential mount gotcha
- [Claude Code credential persistence — .credentials.json + .claude.json](https://github.com/tfvchow/field-notes-public/issues/10) — both files required
- [davidmuraya.com — BackgroundTasks vs ARQ](https://davidmuraya.com/blog/fastapi-background-tasks-arq-vs-built-in/) — MEDIUM confidence

---

*Stack research for: geo-api FastAPI service (geo-seo-claude milestone)*
*Researched: 2026-06-01*
