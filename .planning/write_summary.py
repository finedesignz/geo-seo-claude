import pathlib
content = (
"# Project Research Summary
"
"
"
"**Project:** geo-api
"
"**Domain:** Async audit-as-a-service -- FastAPI wrapping a brownfield Claude Code skill toolkit; headless LLM scoring; Postgres job queue; Coolify deploy
"
"**Researched:** 2026-06-01
"
"**Confidence:** HIGH
"
"
"
"## Executive Summary
"
"
"
"geo-api is a containerized FastAPI service that turns an interactive markdown-driven Claude Code GEO audit skill into a callable HTTP API. Consumers (hyperoptimizedwebsites, ottolax) POST a URL and receive a job ID; a separate worker process imports the existing scripts/*.py scrapers in-process, then shells out to claude -p for LLM synthesis, persisting the 0-100 GEO Score and findings to Postgres. The architecture is straightforward -- thin HTTP layer, Postgres job queue via SELECT FOR UPDATE SKIP LOCKED, same image two CMD entries for API vs worker -- except for one dependency that dominates everything: the scoring engine must run as claude -p on a Claude subscription inside a Docker container. Until that is proven in a container with no TTY, no other work is meaningful.
"
"
"
"Two gating risks must be resolved before any API or job-queue code is written. Risk 1 -- the claude -p headless container spike: auth credentials must survive container restarts via a persistent volume mount (~/.claude/), --dangerously-skip-permissions must be passed or the process hangs silently, and the June 15 2026 billing split means usage draws from a separate Agent SDK credit pool (Pro: 20/mo) that could be exhausted by automated audits. Risk 2 -- SSRF and response-size hardening of scripts/fetch_page.py: the existing fetcher accepts arbitrary URLs with only a scheme check, uses allow_redirects=True without IP re-validation, and loads full response bodies into memory -- all three are exploitable from the /audit endpoint and must be fixed in a shared http.py helper before the endpoint is wired to any network path.
"
"
"
"The recommended stack is unambiguous: FastAPI 0.115 + SAQ + psycopg3 (psycopg[binary]>=3.2) + SQLAlchemy 2 Core + Alembic + scalar-fastapi. SAQ (not ARQ, not Celery, not BackgroundTasks) because audits are multi-minute subprocesses that cannot run in the web worker process. psycopg3 because its AsyncConnectionPool is built-in and is the officially supported SQLAlchemy 2 async driver. The job queue is Postgres itself (SKIP LOCKED) -- no Redis broker needed at this volume. BackgroundTasks are explicitly wrong for this workload and must not appear anywhere in the implementation.
"
)
pathlib.Path(r"C:/Users/artic/GitHub/geo-seo-claude/.planning/research/SUMMARY.md").write_text(content, encoding="utf-8")
print("intro written")
