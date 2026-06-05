---
phase: 05-bun-hono-api-layer
plan: 02
subsystem: api-read-docs-webhook
tags: [poll, history, healthz, openapi, scalar, webhook, ssrf-toctou, response-dto]
requires:
  - "@geo/api createApp + bearerAuth + POST /audit (05-00/05-01)"
  - "@geo/db consumer-scoped getJob/listJobs (05-00)"
  - "@geo/fetch createSafeRequester SSRF-safe POST (05-00)"
  - "@geo/worker pipeline completeJob/failJob call sites (Phase 4)"
provides:
  - "GET /audit/{id} ownership-scoped poll + response DTO (API-02, D-05/D-15)"
  - "GET /audits paginated consumer-scoped history + list DTO (API-03, D-06/D-15)"
  - "GET /healthz deep DB check 200/503 via dal.ping (API-06, D-07)"
  - "/openapi.json BearerAuth security scheme + /docs Scalar + generated docs/api.md (API-07)"
  - "@geo/worker deliverWebhook + pipeline wiring (API-08 fire half, D-08/D-12)"
affects:
  - packages/api
  - packages/db
  - packages/worker
tech-stack:
  patterns:
    - "explicit response DTOs (no raw AuditJob row; internal columns never serialized)"
    - "ownership check job.consumerId !== c.get('consumer_id') → 404 (no existence leak)"
    - "deep healthz via additive dal.ping() (SELECT 1) so tests force 503 by closing PGlite"
    - "registerComponent('securitySchemes','BearerAuth',{type:'http',scheme:'bearer'})"
    - "non-fatal fire-and-forget webhook at completeJob + 3 terminal failJob sites"
key-files:
  created:
    - packages/api/src/routes/audit-get.ts
    - packages/api/src/routes/audits-list.ts
    - packages/api/src/routes/healthz.ts
    - packages/api/scripts/gen-docs.ts
    - packages/api/docs/api.md
    - packages/api/src/__tests__/audit-get.test.ts
    - packages/api/src/__tests__/audits-list.test.ts
    - packages/api/src/__tests__/healthz.test.ts
    - packages/api/src/__tests__/openapi.test.ts
    - packages/worker/src/webhook.ts
    - packages/worker/src/__tests__/webhook.test.ts
  modified:
    - packages/api/src/app.ts
    - packages/api/src/index.ts
    - packages/api/package.json
    - packages/db/src/dal.ts
    - packages/worker/src/pipeline.ts
    - packages/worker/src/index.ts
decisions:
  - "Added AuditDal.ping() (SELECT 1) — additive @geo/db method so /healthz drives a closed PGlite db to force 503 without a getSql/global singleton."
  - "Response findings DTO uses z.record(z.string(), z.unknown()) not z.unknown() — z.unknown() in a 200 response schema collapses the inferred body to never under tsup DTS (zod-openapi 0.19 quirk)."
  - "GET /audits over-cap limit (>100) → 400 from zod .max(100) (request validation), not a silent clamp."
  - "Webhook delivery is fire-and-forget (void + .catch) from the pipeline — never awaited, never affects job state; requester injectable via PipelineDeps.webhookRequester for tests."
  - "WH-02 SSRF block proven with the REAL createSafeRequester + loopback resolver (SSRF semantics never mocked); only DNS is injected."
metrics:
  duration: ~30 min
  completed: 2026-06-05
  tasks: 3
  files: 17
---

# Phase 5 Plan 02: Wave 2 — Read Endpoints + Docs + Webhook Summary

Completes the public API surface and closes the webhook half of API-08: ownership-scoped `GET /audit/{id}` poll, paginated consumer-scoped `GET /audits` history (both with internal-column-free response DTOs), deep `GET /healthz` 200/503 DB check, the `/openapi.json` BearerAuth security scheme + Scalar `/docs` + generated `docs/api.md`, and an SSRF-safe non-fatal webhook fired from the worker pipeline at completion and terminal failure. All five suites green (api/worker/db/fetch/core); api + worker DTS builds green.

## What Was Built

### Task 1 — GET /audit/{id} + GET /audits + GET /healthz (API-02/03/06) — commits b9456ab, e378717
- `routes/audit-get.ts`: `createRoute` GET `/audit/{job_id}`, `security:[{BearerAuth:[]}]`. Handler `getJob(id)` then ownership check `!job || job.consumerId !== consumer_id → 404` (no cross-consumer read, no existence leak, D-05). Explicit poll DTO (D-15): body built imperatively, keys added only when present — `score`/`findings` only when `done`, `error_code` only when `failed`; never spreads the raw row. `findings` schema is `z.record(z.string(), z.unknown())`.
- `routes/audits-list.ts`: `createRoute` GET `/audits`, query `z.object({ page: coerce.int.min(1).default(1), limit: coerce.int.min(1).max(100).default(20) })`. Handler `offset=(page-1)*limit` → `listJobs({ consumerId, limit, offset })` → maps each row to a list-item DTO `{ job_id, url, status, score?, created_at }` (D-06/D-15) — no internal columns spread.
- `routes/healthz.ts`: `createRoute` GET `/healthz`, no `security`. Handler `try dal.ping()` → 200 `{status:'ok',db:'ok'}`, `catch` → 503 `{status:'error',db:'error'}`. Path already in the auth EXEMPT set (Wave 1) → public.
- `@geo/db dal.ts`: additive `ping(): Promise<void>` (`SELECT 1`) on `AuditDal` so /healthz does a deep check and tests force 503 by closing the PGlite db.
- All three registered in `createApp`; BearerAuth security scheme registered (see Task 2).
- Tests: `audit-get.test.ts` (done→score+findings, queued→status-only, not-found 404, cross-consumer 404, DTO excludes internal columns, tokenless 401); `audits-list.test.ts` (consumer scoping, pagination disjoint pages, limit cap 400, DTO-only keys, tokenless 401); `healthz.test.ts` (200 reachable tokenless, 503 after closing PGlite).

### Task 2 — /openapi.json BearerAuth + /docs + docs/api.md (API-07) — commit d7bf5b1
- `app.ts`: `app.openAPIRegistry.registerComponent('securitySchemes','BearerAuth',{type:'http',scheme:'bearer'})` so the spec carries the scheme; protected routes reference it.
- `scripts/gen-docs.ts` + `gen-docs` npm script: boots `createApp` with a no-op DAL stub (only `/openapi.json` is read — derived from zod schemas, no DB), renders a deterministic markdown table to `docs/api.md` (rule 21 backend adapter). **Regenerate:** `bun run --cwd packages/api gen-docs`.
- `docs/api.md` committed: 4 paths (POST /audit, GET /audit/{job_id}, GET /audits BearerAuth; GET /healthz public) + BearerAuth security-scheme table.
- `openapi.test.ts`: spec is OpenAPI 3.x, has `components.securitySchemes.BearerAuth` (http/bearer), lists all four paths, `/docs` returns 200.

### Task 3 — webhook delivery + pipeline wiring (API-08 fire half) — commit fbbeeb6
- `worker/webhook.ts`: `deliverWebhook(callbackUrl, payload, deps?)` POSTs `{job_id,status,score,findings}` via `@geo/fetch createSafeRequester` (timeout 5s, retries 2, 64 KB response cap). Fire-time hardening from createSafeRequester (D-12): host re-resolved + IP-classified per attempt (TOCTOU), redirects disallowed (3xx→REDIRECT_BLOCKED), response-size cap, bounded timeout+retries. NON-FATAL: every failure logged + swallowed; deterministic SSRF/redirect/size blocks are not re-attempted; a throwing requester is caught; never throws. Requester injectable for tests.
- `worker/pipeline.ts`: local `tryDeliverWebhook(status, score, findings)` helper — fires only when `job.callbackUrl` present, fully non-fatal (`void deliverWebhook(...).catch(...)`); wired at the `completeJob` success site (`done`, score, findings) and all three terminal `failJob` sites (`failed`, null, null). Additive — job state transitions unchanged, delivery never awaited. `PipelineDeps.webhookRequester` added as the test seam.
- `webhook.test.ts`: WH-01 public POST captures payload; WH-02 private-resolving host blocked at fire time with the REAL requester (loopback resolver, SSRF not mocked), no throw; WH-03 failing requester swallowed (1+2 attempts) + WH-03b throwing requester swallowed; WH-04a pipeline fires on completion (status done, job_id) and job stays done; WH-04b no fire without callbackUrl; WH-04c failing delivery never fails the job.

## Deviations from Plan

**1. [Rule 2 - Missing functionality] Added `AuditDal.ping()` to @geo/db**
- During: Task 1 (healthz). The DAL had no liveness probe; the plan suggested "prefer a dal method so tests can drive a closed PGlite db." Added an additive `ping()` (`SELECT 1`) rather than reaching for a global `getSql()` singleton (which would break the DI/no-singleton pattern and PGlite test injection).
- Files: `packages/db/src/dal.ts`. Commit b9456ab. db suite re-verified green (55 passed, 1 skipped).

**2. [Rule 3 - Blocking] z.unknown() in the poll 200 response collapsed the DTS body to `never`**
- During: Task 1 api DTS build (`bun run --cwd packages/api build`). `@hono/zod-openapi@0.19` + zod v3 infers a `z.unknown()`-bearing 200 response schema as `never`, so the handler return failed type-check (vitest transpile did not catch it).
- Fix: `findings: z.record(z.string(), z.unknown())` and an imperative key-only-when-present body (cast `job.findings as Record<string,unknown>`). No behavior change. Commit e378717.

**3. [scope note] BearerAuth security-scheme registration landed in Task 1's commit**
- `registerComponent('securitySchemes','BearerAuth',...)` was added to `createApp` in b9456ab (Task 1) since the registered routes reference the scheme; its dedicated test (`openapi.test.ts`) and the docs generation are the Task 2 commit (d7bf5b1). Behavior matches plan intent.

## Threat Model Coverage

- T-05-02-01 (info disclosure, GET /audit + /audits): ownership 404 on others'/missing jobs (no existence leak); `listJobs` consumer-equality scoping. Proven by audit-get/audits-list tests. Response DTOs exclude all internal columns (D-15) — asserted absent. ✓
- T-05-02-02 (SSRF, webhook fire): real `createSafeRequester` re-resolves + validates host on every attempt before POST; loopback-resolving host blocked, never connected. Proven by WH-02 with no SSRF mock. ✓
- T-05-02-03 (DoS, webhook delivery): bounded timeout (5s) + capped retries (2) + 64 KB response cap; non-fatal — never awaited, never blocks/fails the job. Proven by WH-03/WH-04c. ✓
- T-05-02-04 (info disclosure, /openapi.json): spec exposes route shapes only (no secrets); /healthz, /openapi.json, /docs intentionally public. ✓

No secrets committed (test tokens are fixtures; `.env.example` only).

## Verification

- `bun run --cwd packages/api test -- --run` → 40 passed (audit-get 6, audits-list 5, healthz 2, openapi 4, audit-post 9, auth 12, scaffold 2).
- `bun run --cwd packages/worker test -- --run` → 38 passed (webhook 7 + pipeline/scorer/worker/scaffold 31).
- `bun run --cwd packages/db test -- --run` → 55 passed, 1 skipped (no regression; ping additive).
- `bun run --cwd packages/fetch test -- --run` → 116 passed, 7 todo (no regression).
- `bun run --cwd packages/core test -- --run` → 106 passed (no regression).
- `bun run --cwd packages/api build` + `bun run --cwd packages/worker build` → ESM+CJS+DTS green (after `@geo/db build` to refresh ping types).
- `/openapi.json` validates OpenAPI 3.1 with `components.securitySchemes.BearerAuth` + all 4 paths; `/docs` 200; `docs/api.md` committed.

## docs/api.md regeneration

`bun run --cwd packages/api gen-docs`

## Known Stubs

None. All three read routes use the real PGlite-backed DAL; healthz does a real `SELECT 1`; the webhook uses the real SSRF-safe requester (only DNS injected in tests). The `gen-docs` DAL stub is a build-time tool that only reads the spec — no runtime/data-rendering stub.

## Self-Check: PASSED
