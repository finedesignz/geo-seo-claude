# geo-api

## What This Is

`geo-api` is a standalone, containerized **Bun + Hono HTTP service** (all-TypeScript) that automates the GEO (Generative Engine Optimization) audit previously delivered as an interactive `geo-seo-claude` Claude Code skill. Consumer apps — primarily `../hyperoptimizedwebsites` (TS, imports `@geo/core` inline) and `../ottolax` (Python, calls the HTTP API) — `POST` a website URL and reliably get back a 0–100 GEO Score with findings, fully automated. The deterministic ~80% of an audit lives in a zero-dependency shared TS package (`@geo/core`); the irreducible judgment is a single structured Anthropic SDK scoring call. Audits run as durable background jobs over a Postgres SKIP-LOCKED queue, with a cron container for scheduled re-audits.

## Core Value

**Any consumer app can POST a URL and reliably get back a 0–100 GEO Score with findings — fully automated, no human in the loop.** The deterministic ~80% of an audit (crawl/robots, llms.txt, schema templates, SSR/CSR detection, citability heuristics) is plain code in a shared package; only the irreducible judgment is a single structured LLM call. (Validated by v1.0 — still the right priority.)

## Current State

**v1.0 SHIPPED 2026-06-05 — code-complete + independently verified in-process.** 7 phases, 26 plans, 372 tests passing across core/fetch/db/api/worker/cron + examples. All 35 v1 requirements satisfied (audit `.planning/milestones/v1.0-MILESTONE-AUDIT.md`, status: passed, 0 real gaps).

**Remaining operator / cross-repo actions (documented, NOT v1.0 gaps):**
- **DEFERRED-LIVE — live production deploy** behind an operator Coolify gate: provision the Coolify app + Postgres + secrets, then run `deploy-verify.sh` (healthz + real `/audit` round-trip). See `.planning/phases/06-containerize-coolify-deploy/DEPLOY-RECORD.md` + `docs/deploy.md`. Branch is unpushed (third-party origin needs operator authorization). Discharges DATA-01/02, WORK-01, DEPLOY-01/02/04 live.
- **DEFERRED cross-repo (rule 20) — consumer wirings**: `hyperoptimizedwebsites` `@geo/core` inline dependency (CONS-01) and `ottolax` Python client integration (CONS-02). Consumer artifacts/contracts shipped in-repo (`examples/how-inline-usage.ts`, `examples/ottolax-client.py`, `docs/consumers.md`); the actual wiring happens in those repos.

## Requirements

### Validated

<!-- Pre-existing (inferred from .planning/codebase/) -->
- ✓ Public-web scraping (YouTube, Reddit, LinkedIn, G2, Wikipedia/Wikidata) — pre-existing `scripts/*.py`
- ✓ LLM-as-orchestrator interactive GEO audit (0–100 score) — pre-existing skill (now superseded by the automated service for service consumers)
- ✓ Screenshot capture + PDF report generation — pre-existing
- ✓ Local Flask CRM dashboard (port 5050) — pre-existing, kept as-is

<!-- Shipped in v1.0 -->
- ✓ Zero-dep TS `@geo/core` (checkRobots, generateLlmsTxt, getSchemaTemplates, computeCitabilityScore, detectRendering), dual ESM/CJS — v1.0
- ✓ SSRF/fetch hardening (`@geo/fetch`): resolve-then-pin, redirect re-validation, size cap + decompression-bomb defense, structured errors — v1.0
- ✓ Structured Anthropic SDK scoring (forced tool-use, JSON schema, prompt caching, clean failure) — v1.0
- ✓ Coolify Postgres durable queue (`@geo/db`): SKIP LOCKED claim, lease fencing, advisory-locked migration runner, env-only DATABASE_URL — v1.0
- ✓ Worker pipeline (`@geo/worker`): @geo/core checks → scoring → persist, bounded concurrency, reclaim sweep, graceful drain — v1.0
- ✓ Bun+Hono REST API (`@geo/api`): async submit/poll, paginated history, bearer auth, consumer-scoped dedup, webhook w/ fire-time SSRF re-check, deep `/healthz`, `/openapi.json` + Scalar `/docs` — v1.0
- ✓ Single multi-stage container image, role-by-command (api/worker/cron), secrets from env, deploy-verify smoke script + Coolify runbook — v1.0 (in-process; live deploy DEFERRED-LIVE)
- ✓ Cron re-audit container (`@geo/cron`) + consumer artifacts (HOW inline example, ottolax Python client) — v1.0 (live cross-repo wiring DEFERRED)

### Active

<!-- v2 candidates — deferred from v1.0 by design. -->
- [ ] **Operator**: live Coolify deploy + run `deploy-verify.sh` (discharges DEFERRED-LIVE deploy items)
- [ ] **Cross-repo**: wire `hyperoptimizedwebsites` to `@geo/core` (CONS-01) and `ottolax` to the Python client (CONS-02)
- [ ] **REP-01**: PDF report endpoint for a completed audit
- [ ] **REP-02**: Score-over-time history/trend per site
- [ ] **OPS-01**: Rate limiting per consumer/API key
- [ ] **OPS-02**: Idempotency keys on `POST /audit`
- [ ] (candidate) LISTEN/NOTIFY webhook dispatcher over current poll/fire

### Out of Scope

- Rewriting the existing scrapers — ported to `@geo/core` (TS), originals kept
- Migrating/replacing the Flask CRM (`scripts/webapp/app.py`) — kept as-is
- `claude -p` / agent-host scoring — killed; score is a structured SDK call
- Routing deterministic checks through LLM calls — they are plain `@geo/core` functions
- A new end-user-facing UI for geo-api — consumer apps own their UIs
- Multi-tenant billing / Titanium licensing — internal service for now
- Synchronous `/audit`, WebSocket streaming, GraphQL/gRPC — async REST + webhook suffice

## Context

- Shipped v1.0 as an **all-TypeScript Bun workspace** (~125 tracked files under `packages/`): `@geo/core`, `@geo/fetch`, `@geo/db`, `@geo/worker`, `@geo/api`, `@geo/cron`. 372 tests (vitest; PGlite for DB, in-process app harness for API/cron).
- Tech stack: Bun + Hono, `@hono/zod-openapi` + `@scalar/hono-api-reference`, `@anthropic-ai/sdk`, postgres.js, undici + ipaddr.js, tsup dual ESM/CJS, single multi-stage Dockerfile (role-by-command).
- The original repo is a Claude Code skill package (markdown prompts + stateless Python tools); v1.0 added the automated TS service alongside it without disturbing the skill or the Flask CRM.
- CONCERNS.md items resolved in v1.0: SSRF + size caps (now `@geo/fetch`), racy JSON writes (now Postgres). Thin test coverage replaced by 372 tests; CI/live deploy remain operator-gated.

## Constraints

- **Tech stack**: All-TS. Service = Bun + Hono (rule 21 docs). Scoring via TS `@anthropic-ai/sdk`. Python scrapers ported to TS in `@geo/core`.
- **Shared core**: `@geo/core` zero-dep, imported inline by HOW and the service; ottolax (Python) reaches the same logic via HTTP.
- **Database**: Postgres on Coolify (`DATABASE_URL` in Coolify env, never in repo).
- **Scoring**: one structured Anthropic SDK call (JSON schema + prompt caching); API key in Coolify env.
- **Deployment**: standalone container on Coolify (`coolify.titaniumlabs.us`). Origin is third-party — branch/tag push needs operator authorization.
- **Security**: `/audit` accepts arbitrary URLs → SSRF + size-cap hardening is a prerequisite; API surface authenticated.
- **Docs**: ships `/openapi.json` + `/docs`, plus `docs/` + `README.md` + `CLAUDE.md` (rule 21).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| All-TS: Bun+Hono service + TS `@geo/core`, port Python scrapers to TS | One source of truth; HOW imports inline, service imports same code; ottolax via HTTP | ✓ Good |
| Scoring = single structured Anthropic SDK call (forced tool-use, JSON schema, prompt caching) | A score needs one judgment call, not an agent host; cheap, deterministic-shaped, cacheable | ✓ Good |
| Deterministic ~80% in zero-dep `@geo/core` | Stops a robots.txt check from becoming a per-audit Claude call; HOW runs cheap checks inline | ✓ Good |
| Standalone Coolify service (not embedded library) | Two committed consumers (HOW + ottolax) justify the network boundary now | ✓ Good |
| Postgres SKIP LOCKED durable queue + advisory-locked migrations (no Redis/Celery) | Durable, concurrent-safe, survives redeploy; one less moving part | ✓ Good |
| SSRF resolve-then-pin at every URL ingress + webhook re-validated at fire-time | DNS-rebinding-safe; the callback is as dangerous as the audit URL | ✓ Good |
| Single multi-stage image, role-by-command (api/worker/cron) | One artifact, three run targets; no duplicated build | ✓ Good |
| Async job model (`POST /audit`→job_id, `GET /audit/{id}`) | Audits take tens of seconds–minutes; can't block the request | ✓ Good |
| Live deploy gated to operator (Coolify provision + secrets + third-party origin push) | No fabricated UUIDs/secrets/transcripts; human gate per global rule 9 | ✓ Good (deferred-live) |
| Consumer wiring left to consumer repos (rule 20) | Artifacts/contracts shipped here; actual dep wiring belongs in HOW/ottolax | ✓ Good (deferred cross-repo) |
| Bun+Hono replaced the originally-assumed FastAPI plan | All-TS decision + `@geo/core` reuse; superseded the early Python/FastAPI research | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`): requirements invalidated/validated/emerged → update; decisions → log; "What This Is" → update if drifted.

**After each milestone** (via `/gsd:complete-milestone`): full review of all sections; Core Value check; audit Out of Scope; update Current State + Context.

---
*Last updated: 2026-06-05 after v1.0 milestone*
