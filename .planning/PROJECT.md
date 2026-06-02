# geo-api

## What This Is

`geo-api` is a standalone, containerized **FastAPI service** that wraps the existing `geo-seo-claude` audit toolkit (the `scripts/*.py` scrapers + the markdown-driven GEO audit) and exposes it as an HTTP API. It lets other applications — primarily `../hyperoptimizedwebsites` and `../ottolax` — request a Generative Engine Optimization (GEO) audit of any website URL, get back a 0–100 GEO Score with findings, and re-run audits on a schedule. It turns an interactive, human-driven Claude Code skill into an automated, callable service.

## Core Value

**Any consumer app can POST a URL and reliably get back a 0–100 GEO Score with findings — fully automated, no human in the loop.** The deterministic ~80% of an audit (crawl/robots, llms.txt, schema templates, SSR/CSR detection, citability heuristics) is plain code in a shared package; only the irreducible judgment is a single structured LLM call.

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

- [ ] Shared **`@geo/core`** package holding the deterministic ~80% as zero-dep plain functions: crawl/robots check, llms.txt generation, schema.org templates, citability heuristic, SSR/CSR detection. Imported by BOTH the service and `../hyperoptimizedwebsites` (no per-audit LLM call for deterministic checks; HOW can run cheap checks inline without round-tripping the service)
- [ ] Harden URL fetching against SSRF (block private/link-local/cloud-metadata IPs, validate redirects, DNS-rebind safe) and add response-size/decompression caps before any URL is exposed to the network
- [ ] Service exposing `POST /audit {url}` → `{job_id}` (async job model)
- [ ] `GET /audit/{job_id}` → status + 0–100 GEO Score + findings
- [ ] Scoring = a single **structured Anthropic SDK call** with a JSON output schema + prompt caching (NOT `claude -p`, NOT an agent host). Deterministic findings feed the prompt; the LLM only renders the irreducible judgment into the score
- [ ] Persist audit jobs + history in **Coolify Postgres** (replacing racy `~/.geo-prospects/*.json` writes)
- [ ] Expose `/openapi.json` + `/docs` (scalar-fastapi) per docs standard (global rule 21)
- [ ] Containerize and deploy as a standalone service on **Coolify**
- [ ] Scheduled re-audits: a cron container re-audits a configured list of sites
- [ ] Event-driven on-demand audits triggered by `../hyperoptimizedwebsites` and `../ottolax` over HTTP
- [ ] Auth on the API surface (consumer apps authenticate; not unauthenticated public)

### Out of Scope

- Rewriting the existing scrapers — reuse as-is; only `fetch_page.py` gets security hardening — *avoid churn / preserve working behavior*
- Migrating or replacing the Flask CRM (`scripts/webapp/app.py`) — *keep as-is for now; may fold into the service in a later milestone*
- Headless `claude -p`-in-container / agent-host scoring — *killed: the 0–100 score is a structured SDK call, not an agent run. Only revisit if a real driver emerges for multi-step tool-use DURING an audit (driver #3); for a score it does not exist*
- Routing deterministic checks (robots, llms.txt, schema, SSR/CSR) through LLM calls — *they are plain functions in `@geo/core`; sending them to Claude is waste and the exact failure mode to prevent*
- A new end-user-facing UI for geo-api — *it's a service; consumer apps own their UIs*
- Multi-tenant billing / Titanium licensing wiring — *internal service for now; revisit if it becomes user-facing*

## Context

- **Brownfield.** Full codebase map exists in `.planning/codebase/` (STACK, ARCHITECTURE, STRUCTURE, CONVENTIONS, TESTING, INTEGRATIONS, CONCERNS). Mapped at commit `9eec32f`, 2026-06-01.
- The repo is a **Claude Code skill package**, not a conventional app: control flow lives in markdown prompts backed by a stateless Python tool layer (WAT-style: LLM orchestrator + deterministic CLI tools).
- The **scoring engine currently requires a Claude session** — the 0–100 synthesis is reasoning over markdown, not pure Python. The headless `claude -p` approach is the key unlock for automation and is the project's main technical risk.
- `CONCERNS.md` flags: SSRF + no response-size caps in `fetch_page.py`, unauthenticated Flask CRM with racy read-modify-write JSON writes, broad `except`/silent `pass`, brittle third-party scraping, thin test coverage (one SSR-only pytest module), no CI.
- Stack rules: Postgres on Coolify (global rule 17), no Supabase (rule 18), FastAPI gets `/openapi.json` + scalar `/docs` natively (rule 21).

## Constraints

- **Tech stack**: **All-TS** (decided). Service = **Bun + Hono** per global rule 21 (`@hono/zod-openapi` + `@scalar/hono-api-reference` for `/openapi.json` + `/docs`; bootstrap from `_templates/bun-hono-app/`). Scoring via the TS `@anthropic-ai/sdk`. The existing Python `scripts/*.py` scrapers are **ported to TS** inside `@geo/core` (not reused in-process).
- **Shared core**: `@geo/core` = zero-dependency **TS** package of deterministic functions, imported inline by HOW (lives in/next to HOW's `packages/` monorepo) and by the Bun+Hono service; **ottolax (Python) reaches the same logic via the service's HTTP API.**
- **Database**: Postgres on Coolify (`DATABASE_URL` in Coolify env, never in repo). Not Supabase, not SQLite for prod.
- **Scoring**: one structured Anthropic SDK call (JSON output schema + prompt caching) — API key in Coolify env. NOT `claude -p`, NOT an agent host.
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
| Scoring = structured Anthropic SDK call (JSON schema + prompt caching) | Removes the riskiest/most-expensive phase (claude -p container spike); a score needs one judgment call, not an agent host; cheap + deterministic-shaped output | — Pending |
| Deterministic 80% in shared `@geo/core` package | Stops "we built a service" from turning a robots.txt check into a per-audit Claude call; lets HOW run cheap checks inline without round-tripping; one source of truth for the logic | — Pending |
| Two real consumers (HOW + ottolax) justify the network boundary now | ≥2 committed consumers = the service earns its keep today; folding into HOW would force a painful double-paid extraction when ottolax needs it | ✓ Good |
| All-TS: Bun+Hono service + TS `@geo/core`, port Python scrapers to TS | HOW (TS) imports `@geo/core` inline; the service imports the SAME code; one source of truth, zero cross-language duplication; ottolax (Python) consumes via HTTP. Cost accepted: porting scrapers to TS | ✓ Good |

> **Research note:** `.planning/research/STACK.md` was produced under the earlier Python/FastAPI assumption (SAQ, psycopg3, claude -p). Its **stack-layer specifics are superseded** by the All-TS decision and the structured-SDK scoring decision above. The FEATURES, ARCHITECTURE, and PITFALLS research remain valid (language-agnostic: SSRF, async job state machine, SKIP LOCKED queue, Coolify topology, dedup/caching, healthcheck depth).
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
