# geo-api

## What This Is

`geo-api` is a standalone, containerized **FastAPI service** that wraps the existing `geo-seo-claude` audit toolkit (the `scripts/*.py` scrapers + the markdown-driven GEO audit) and exposes it as an HTTP API. It lets other applications — primarily `../hyperoptimizedwebsites` and `../ottolax` — request a Generative Engine Optimization (GEO) audit of any website URL, get back a 0–100 GEO Score with findings, and re-run audits on a schedule. It turns an interactive, human-driven Claude Code skill into an automated, callable service.

## Core Value

**Any consumer app can POST a URL and reliably get back a 0–100 GEO Score with findings — fully automated, no human in the loop.**

## Requirements

### Validated

<!-- Inferred from existing code (.planning/codebase/) — already working and relied upon. -->

- ✓ Public-web scraping across YouTube, Reddit, LinkedIn, G2, Wikipedia/Wikidata, etc. (`scripts/brand_scanner.py`, `scripts/*.py`) — existing
- ✓ Page fetch + SSR/HTML parsing with requests + BeautifulSoup4/lxml (`scripts/fetch_page.py`) — existing
- ✓ LLM-as-orchestrator GEO audit producing a 0–100 GEO Score, fanned out across 5 parallel subagents (`geo/SKILL.md`, `skills/geo-*/SKILL.md`, `agents/*.md`) — existing
- ✓ Screenshot capture (Playwright/Pillow) and PDF report generation (pandoc + headless Chrome) — existing
- ✓ Local Flask CRM dashboard for prospect tracking on port 5050, JSON-file backed under `~/.geo-prospects/` (`scripts/webapp/app.py`) — existing
- ✓ Stateless CLI tools emitting JSON to stdout — existing

### Active

<!-- New scope for the geo-api milestone. Hypotheses until shipped + validated. -->

- [ ] De-risk spike: prove headless `claude -p` runs inside a container using the local Claude **subscription** (not an API key) and returns a GEO score
- [ ] Harden `scripts/fetch_page.py` against SSRF (block private/link-local IPs, validate redirects) and add response-size caps before any URL is exposed to the network
- [ ] FastAPI service exposing `POST /audit {url}` → `{job_id}` (async job model)
- [ ] `GET /audit/{job_id}` → status + 0–100 GEO Score + findings
- [ ] Scoring/synthesis step runs headless via `claude -p` on the local subscription
- [ ] Reuse existing `scripts/*.py` scrapers in-process — do NOT rewrite them
- [ ] Persist audit jobs + history in **Coolify Postgres** (replacing racy `~/.geo-prospects/*.json` writes)
- [ ] Expose `/openapi.json` + `/docs` (scalar-fastapi) per docs standard (global rule 21)
- [ ] Containerize and deploy as a standalone service on **Coolify**
- [ ] Scheduled re-audits: a cron container re-audits a configured list of sites
- [ ] Event-driven on-demand audits triggered by `../hyperoptimizedwebsites` and `../ottolax` over HTTP
- [ ] Auth on the API surface (consumer apps authenticate; not unauthenticated public)

### Out of Scope

- Rewriting the existing scrapers — reuse as-is; only `fetch_page.py` gets security hardening — *avoid churn / preserve working behavior*
- Migrating or replacing the Flask CRM (`scripts/webapp/app.py`) — *keep as-is for now; may fold into the service in a later milestone*
- Using the Anthropic API key for scoring — *explicit decision: scoring runs on the local Claude subscription via `claude -p`*
- A new end-user-facing UI for geo-api — *it's a service; consumer apps own their UIs*
- Multi-tenant billing / Titanium licensing wiring — *internal service for now; revisit if it becomes user-facing*

## Context

- **Brownfield.** Full codebase map exists in `.planning/codebase/` (STACK, ARCHITECTURE, STRUCTURE, CONVENTIONS, TESTING, INTEGRATIONS, CONCERNS). Mapped at commit `9eec32f`, 2026-06-01.
- The repo is a **Claude Code skill package**, not a conventional app: control flow lives in markdown prompts backed by a stateless Python tool layer (WAT-style: LLM orchestrator + deterministic CLI tools).
- The **scoring engine currently requires a Claude session** — the 0–100 synthesis is reasoning over markdown, not pure Python. The headless `claude -p` approach is the key unlock for automation and is the project's main technical risk.
- `CONCERNS.md` flags: SSRF + no response-size caps in `fetch_page.py`, unauthenticated Flask CRM with racy read-modify-write JSON writes, broad `except`/silent `pass`, brittle third-party scraping, thin test coverage (one SSR-only pytest module), no CI.
- Stack rules: Postgres on Coolify (global rule 17), no Supabase (rule 18), FastAPI gets `/openapi.json` + scalar `/docs` natively (rule 21).

## Constraints

- **Tech stack**: FastAPI (Python 3) — chosen for native OpenAPI, async/BackgroundTasks for long-running audits, and Pydantic-typed contracts.
- **Database**: Postgres on Coolify (`DATABASE_URL` in Coolify env, never in repo). Not Supabase, not SQLite for prod.
- **Scoring**: headless `claude -p` on the local Claude subscription — NOT an API key.
- **Deployment**: standalone container on Coolify (`coolify.titaniumlabs.us`).
- **Security**: `/audit` accepts arbitrary URLs → SSRF + size-cap hardening is a prerequisite, not optional. API surface must be authenticated.
- **Docs**: must ship `/openapi.json` + `/docs`, plus `docs/` + `README.md` + `CLAUDE.md` (global rule 21).
- **Reuse**: existing scrapers imported, not rewritten.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| FastAPI over the existing Flask | Native OpenAPI/`/docs`, async for long audits, Pydantic-typed `/audit` contract for consumer codegen | — Pending |
| Standalone Coolify service (not embedded library) | One GEO service, many consumers; isolates scraping risk from product apps; single place to maintain | — Pending |
| Async job model (`POST /audit`→job_id, `GET /audit/{id}`) | Audits take tens of seconds to minutes; can't block the request | — Pending |
| Scoring via `claude -p` on subscription | Reuse the markdown-driven scoring engine headlessly without per-call API cost | — Pending (de-risk spike required) |
| Coolify Postgres replaces `~/.geo-prospects/*.json` | JSON files are racy under concurrent writes (CONCERNS.md); need durable, concurrent-safe storage | — Pending |
| Keep Flask CRM unchanged this milestone | Out of scope; avoid scope creep | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-01 after initialization*
