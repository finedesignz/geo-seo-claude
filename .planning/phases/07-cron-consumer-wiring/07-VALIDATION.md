# Phase 7: Cron + Consumer Wiring — Validation (Nyquist Map)

**Built:** 2026-06-04 (planning) · **Mode:** mvp · **Plans:** 3 (2 waves)

This map ties every success criterion / requirement to an automated test signal **now**,
and explicitly marks what is **DEFERRED-LIVE** (needs the deployed geo-api, Phase 6 operator
gate) and what is **DEFERRED CROSS-REPO** (edits to the HOW / ottolax repos, rule 20 — NOT
done in this phase's commits).

## Multi-Source Coverage Audit

| Source | Item | Covered by | Status |
|--------|------|------------|--------|
| GOAL | Scheduled re-audits run automatically | 07-01 (runCron+test), 07-02 (run target+runbook) | COVERED (live firing DEFERRED-LIVE) |
| GOAL | HOW imports @geo/core inline, no HTTP | 07-03 Task 1 | COVERED + PROVEN NOW |
| GOAL | ottolax triggers audit over HTTP, reads score+findings | 07-03 Task 2 | COVERED (live round-trip DEFERRED-LIVE) |
| REQ | DEPLOY-02 (cron re-audits configured list via /audit) | 07-01, 07-02 | COVERED |
| REQ | CONS-01 (HOW inline @geo/core) | 07-03 Task 1 | COVERED + PROVEN NOW |
| REQ | CONS-02 (ottolax HTTP consumer) | 07-03 Task 2 | COVERED |
| REQ | DEPLOY-03 (env-sourced secrets, constraint) | 07-01 env fail-fast, 07-02 .env.example/deploy.md | COVERED |
| CONTEXT | D-1 cron in existing image, Coolify scheduled task | 07-01 one-shot, 07-02 Dockerfile+runbook | COVERED |
| CONTEXT | D-2 env-driven config (CRON_TARGET_URLS/SCHEDULE/API_TOKEN/BASE_URL) | 07-01 env.ts, 07-02 .env.example | COVERED |
| CONTEXT | D-3 cadence > 1h, NO force flag | 07-02 deploy.md cadence warning (no code change) | COVERED |
| CONTEXT | D-4 dedicated `cron` consumer_id | 07-01 test (consumerId=="cron"), 07-02 GEO_API_KEYS :cron | COVERED |
| CONTEXT | D-5 CONS-01 example+test+doc; publish step cross-repo | 07-03 Task 1 + consumers.md | COVERED (HOW-repo edit DEFERRED CROSS-REPO) |
| CONTEXT | D-6 CONS-02 Python client + contract doc | 07-03 Task 2 | COVERED (ottolax-repo edit DEFERRED CROSS-REPO) |
| CONTEXT | D-7 testability split | this VALIDATION.md + per-plan DEFERRED notes | COVERED |
| CONTEXT | D-8 cron uses plain fetch, no @geo/api at runtime | 07-01 (empty runtime deps; @geo/api test-only) | COVERED |
| RESEARCH | No new external packages (legitimacy audit N/A) | 07-01 (deps {}), 07-03 (stdlib urllib) | COVERED |

**No unplanned items. No silent scope reduction.**

## Requirement → Test Map

| Req / Criterion | Behavior | Signal NOW | Command |
|-----------------|----------|-----------|---------|
| DEPLOY-02 | runCron POSTs /audit per URL w/ Bearer, jobs scoped to `cron` | unit (in-process @geo/api + PGlite) | `bun run --cwd packages/cron test -- --run` |
| DEPLOY-02 | partial-failure: bad URL doesn't abort batch; exit code | unit | same |
| DEPLOY-02 | parseTargetUrls comma/newline + invalid-URL/empty fail-fast; slash-strip | unit | `bun run --cwd packages/cron test -- --run env.test` |
| DEPLOY-02 | cron ships in single image | grep | `grep packages/cron/package.json Dockerfile` |
| CONS-01 | @geo/core imports + runs checkRobots/detectRendering OFFLINE | unit | `bun run --cwd examples test -- --run how-inline-usage` |
| CONS-02 | Python client shape valid, stdlib-only, env token | static | `python -c "import ast; ast.parse(open('examples/ottolax-client.py').read())"` |
| DEPLOY-03 | env documented, no baked secrets | grep | `grep CRON_TARGET_URLS .env.example` |
| Phase gate | no regression across suites | full suite | `bun run --filter '*' test` |

## DEFERRED-LIVE (needs deployed geo-api — operator Coolify gate, mirrors Phase 6)

- [ ] **Criterion 1 live:** Coolify Scheduled Task actually firing on `CRON_SCHEDULE`; re-audit jobs appear in audit history.
- [ ] **Criterion 3 live:** `examples/ottolax-client.py` completes a real POST -> poll -> {score,findings} round-trip against the deployed service.
- [ ] Operator: register the cron scheduled task (`bun packages/cron/dist/main.js`, `0 4 * * *` UTC); add `:cron` + `:ottolax` entries to `GEO_API_KEYS`; set `CRON_*` + `GEO_API_BASE_URL` env. Bundle into the Phase-6 post-deploy verify script (rule 14).

## DEFERRED CROSS-REPO (separate repo-scoped sessions — NOT geo-seo-claude commits, rule 20)

- [ ] **HOW repo** (`hyperoptimizedwebsites`): add the `@geo/core` dependency (recommended `file:` dep per docs/consumers.md) and call `checkRobots`/`detectRendering` inline per `examples/how-inline-usage.ts`.
- [ ] **ottolax repo** (`ottolax`): integrate the Python client per `examples/ottolax-client.py` + `docs/consumers.md`, using its `GEO_API_KEYS` bearer.

## Deferred to a future phase (not this phase)

- `force`/`no_dedup` flag on POST /audit for sub-hour forced re-audits (D-3 — API-surface change, own phase).
- File-backed (vs env) cron target list (D-2 — env suffices for the MVP).
