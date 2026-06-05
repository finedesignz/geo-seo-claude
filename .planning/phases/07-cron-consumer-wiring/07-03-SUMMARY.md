---
plan: 07-03
phase: 7
slug: cron-consumer-wiring
wave: 2
status: complete
requirements: [CONS-01, CONS-02]
completed: 2026-06-04
---

# 07-03 SUMMARY — Consumer Artifacts (CONS-01 + CONS-02)

## What was built

**Task 1 — CONS-01: `@geo/core` inline example + offline proof (commit `43e8dc3`)**
- `examples/how-inline-usage.ts` — `inlineGeoChecks` injects a fake `Fetcher` (canned robots.txt `FetchResult`, **no network**) and calls the real `@geo/core` exports (`checkRobots(url, fetcher)`, `detectRendering(html)`). Demonstrates exactly how `hyperoptimizedwebsites` consumes the package inline with zero HTTP to geo-api.
- `examples/how-inline-usage.test.ts` — vitest offline proof: asserts GPTBot BLOCKED + SSR classification with no network. **PROVES ROADMAP criterion 2 / CONS-01 NOW.**
- `examples/{vitest.config.ts,package.json}` — `examples` workspace + test runner; added to root `workspaces`.
- **Verified:** `bun run --cwd examples test -- --run` → 1/1 passed.

**Task 2 — CONS-02: ottolax Python client + consumer docs (commit `6d4c1ce`)**
- `examples/ottolax-client.py` — **stdlib-only** (`urllib.request`/`json`, no pip deps) Python 3 client: reads `GEO_API_BASE_URL` + `GEO_API_TOKEN` from env (token never hardcoded/printed), POSTs `/audit` with `Authorization: Bearer`, polls `GET /audit/{job_id}` until `done|failed` (bounded 120s), prints `{status, score, findings}`. Contract matches `audit-post.ts`/`audit-get.ts` exactly. **`python3 -m py_compile` clean.**
- `docs/consumers.md` — documents BOTH patterns: CONS-01 inline `@geo/core` (file:/workspace dep recommended for the sibling HOW repo; npm-publish alternative; zero-dep + dual ESM/CJS noted) and CONS-02 ottolax HTTP (bearer, dedicated `ottolax` `GEO_API_KEYS` consumer, `/openapi.json` + `/docs` as authoritative contract). Cross-repo wiring (HOW + ottolax repos) clearly marked DEFERRED (rule 20).

## Testability split (honest)
- **PROVEN NOW:** CONS-01 inline import → offline test green (1/1). CONS-02 client → syntactically valid + contract-correct (py_compile).
- **DEFERRED-LIVE:** CONS-02 live round-trip needs the deployed geo-api (Phase 6 operator gate).
- **DEFERRED CROSS-REPO (rule 20):** actual edits inside `hyperoptimizedwebsites` (add `@geo/core` dep + call sites) and `ottolax` (integrate the Python client) repos — separate repo-scoped follow-ups, not in geo-seo-claude commits.

## Security
- No hardcoded secrets (scan clean); Python client + docs read token from env / use placeholders. Inline example does no network I/O. The cron's audited URLs are fetched by the worker (existing SSRF guard), never by the example/client.

## Self-Check: PASSED
- CONS-01 example + offline test committed + green; CONS-02 client + docs committed + py_compile-clean; secret scan clean; no suite regressions (core 106, examples 1).
