---
phase: 5
slug: bun-hono-api-layer
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-02
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Environment constraint

No live socket / no live Anthropic / no live deploy in CI. The Hono app is exercised via **`app.request()`** (in-process); the DAL runs against **PGlite** (reuse Phase 3 harness); callback_url SSRF rejection reuses the **Phase 2 loopback server + mock resolver**. Live `/healthz` + `/audit` round-trip against real Coolify Postgres is a Phase 6 deploy-verify (DEPLOY-04). The webhook fire-on-completion is unit-tested in-process; its real end-to-end delivery is part of the Phase 6 smoke.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (mirror `packages/db`) |
| **Config file** | `packages/api/vitest.config.ts` (Wave 0 installs) |
| **Quick run command** | `bun run --cwd packages/api test -- --run` |
| **Full suite command** | `bun run --cwd packages/api test -- --run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** `bun run --cwd packages/api test -- --run`
- **After every plan wave:** full suite + `bun run --cwd packages/api build` + `bun run --cwd packages/db test -- --run` (migration 0002 + DAL scoping stays green)
- **Before verify:** all suites green; `/openapi.json` validates as OpenAPI 3.x; app types clean
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Wave | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|-------------|-----------------|-----------|-------------------|-------------|--------|
| 5-W0a | 0 | infra/D-11 | migration `0002_add_consumer_id.sql` applies; DAL `insertJob`/`getJob`/`listJobs` consumer-scoped | int (PGlite) | `bun run --cwd packages/db test -- --run` | ❌ W0 | ⬜ pending |
| 5-W0b | 0 | infra/D-12 | `@geo/fetch` `validateUrlHost` + SSRF-safe POST export; private host rejected, public allowed | unit (mock resolver) | `bun run --cwd packages/fetch test -- --run` | ❌ W0 | ⬜ pending |
| 5-W0c | 0 | infra/D-14 | `packages/api` scaffold (OpenAPIHono app, zod v3, Scalar) builds + trivial route test | infra | `bun run --cwd packages/api test -- --run` | ❌ W0 | ⬜ pending |
| 5-API-05 | 1 | API-05 | every protected route returns **401** on missing/invalid bearer; valid key attaches consumer_id; `/healthz`,`/openapi.json`,`/docs` exempt | int (app.request) | `vitest run auth` | ❌ W0 | ⬜ pending |
| 5-API-01 | 1 | API-01 | `POST /audit {url}` zod-validates, normalizes, `insertJob`, returns `{job_id}` without blocking; invalid url → 400 | int (app.request+PGlite) | `vitest run audit` | ❌ W0 | ⬜ pending |
| 5-API-04 | 1 | API-04 | repeat URL within TTL returns cached job_id; prior **failed** job does NOT dedup (re-enqueues) | int (app.request+PGlite) | `vitest run dedup` | ❌ W0 | ⬜ pending |
| 5-API-08 | 1 | API-08 | `callback_url` resolving to private IP → **400** at submit (reuse Phase 2 mock resolver) | int (app.request+mock) | `vitest run callback` | ❌ W0 | ⬜ pending |
| 5-API-02 | 2 | API-02 | `GET /audit/{id}` returns status; done → score+findings; not-found/not-owned → **404** (no cross-consumer read) | int (app.request+PGlite) | `vitest run poll` | ❌ W0 | ⬜ pending |
| 5-API-03 | 2 | API-03 | `GET /audits` paginated, scoped to authenticated consumer | int (app.request+PGlite) | `vitest run history` | ❌ W0 | ⬜ pending |
| 5-API-06 | 2 | API-06 | `GET /healthz` → 200 `{db:"ok"}` when DB reachable; **503** `{db:"error"}` when not | int (app.request) | `vitest run healthz` | ❌ W0 | ⬜ pending |
| 5-API-07 | 2 | API-07 | `GET /openapi.json` valid OpenAPI 3.x (bearer security scheme present); `GET /docs` 200 Scalar; `docs/api.md` generated | int (app.request) | `vitest run openapi` | ❌ W0 | ⬜ pending |
| 5-API-08b | 2 | API-08 | webhook delivery fires on completion via SSRF-safe POST, re-validates host at fire, non-fatal on failure | unit (mock) | `vitest run webhook` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/db/migrations/0002_add_consumer_id.sql` + DAL consumer scoping (D-11) — db tests stay green
- [ ] `@geo/fetch` `validateUrlHost()` + SSRF-safe POST/`createSafeRequester` export (D-12) — fetch tests stay green
- [ ] `packages/api/package.json` (`@geo/api`; `hono`, `@hono/zod-openapi` [zod-v3-compatible], `@scalar/hono-api-reference`, `zod@^3.25`, workspace `@geo/db`/`@geo/fetch`/`@geo/core`), `tsup.config.ts`, `vitest.config.ts`
- [ ] `createApp({ dal, ... })` factory (inject PGlite DAL in tests) + `src/main.ts` Bun.serve
- [ ] Reuse Phase 3 PGlite harness + Phase 2 loopback/mock-resolver (import, don't duplicate)

---

## Security Domain (ASVS L1)

| Threat | STRIDE | Mitigation (test-asserted) |
|--------|--------|----------------------------|
| Anonymous access | Spoofing/Elevation | bearer middleware → 401 on every protected route (5-API-05) |
| Cross-consumer data read | Info disclosure | getJob/listJobs scoped to consumer_id → 404 on others' jobs (5-API-02/03) |
| SSRF via callback_url | Elevation | `validateUrlHost` at submit (400) + re-validate at fire; reuse Phase 2 guard (5-API-08/08b) |
| API key exposure | Info disclosure | `GEO_API_KEYS` env-only, fail-fast at startup; never committed |
| Input injection | Tampering | zod request validation on every route (400) |

---

## Manual-Only / Deferred Verifications

| Behavior | Requirement | Why Deferred | When verified |
|----------|-------------|--------------|---------------|
| Live `/healthz` + real `/audit` round-trip | API-06/01 + DEPLOY-04 | Needs live Coolify Postgres + worker | Phase 6 deploy-verify |
| Real webhook delivery to a consumer endpoint | API-08 | Needs deployed worker + reachable callback | Phase 6 smoke |

*All other phase behaviors have automated app.request()/PGlite/mock-backed verification.*

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (consumer_id migration, SSRF POST export, scaffold)
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
