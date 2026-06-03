# Phase 5: Bun+Hono API Layer - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning
**Mode:** mvp · discuss auto-mode (YOLO defaults)

<domain>
## Phase Boundary

Deliver the Bun+Hono HTTP service that turns the queue + worker into a callable API: authenticated `POST /audit` (async submit + dedup), `GET /audit/{id}` (poll), `GET /audits` (paginated history), `GET /healthz` (deep DB check), `GET /openapi.json` + `GET /docs` (Scalar), and webhook callback on completion (SSRF-checked). Consumes `@geo/db` (DAL), `@geo/fetch` (SSRF validation for callback_url), and `@geo/core` (URL normalization). Covers **API-01..API-08**. Does NOT include: the worker/scoring (Phase 4, done), containerization/Coolify deploy (Phase 6), or the cron re-audit scheduler + consumer wiring (Phase 7).
</domain>

<decisions>
## Implementation Decisions

### Package, framework, docs (API-07)
- **D-01:** New workspace package `packages/api/` (`@geo/api`) — a Bun+Hono service. Exports the Hono `app` (for `app.request()` tests) plus `src/main.ts` (Bun.serve entry; Phase 6 containerizes it). Mirrors existing package tsup/vitest conventions; bootstrap reference: `C:\Users\artic\GitHub\_templates\bun-hono-app\`. (recommended; global rule 21)
- **D-02:** Routes built with **`@hono/zod-openapi`** (`createRoute` + zod schemas — the schemas ARE the OpenAPI spec; never hand-maintain a parallel spec), served at `GET /openapi.json`; **`@scalar/hono-api-reference`** mounted at `GET /docs`. `docs/api.md` generated from the spec and committed (rule 21 backend adapter). (recommended; API-07)

### Auth (API-05)
- **D-03:** **Bearer API-key auth, NOT Titanium licensing** — the ROADMAP explicitly scopes Titanium out ("Multi-tenant billing / Titanium licensing — Internal service for now") and global rule 16's explicit-decision escape applies. Keys live in env ONLY (`GEO_API_KEYS`, e.g. a JSON/CSV map of `token → consumer_id`); a Hono middleware validates `Authorization: Bearer <token>` on every route except `/healthz`/`/openapi.json`/`/docs`, returning **401** (not 404/200) on missing/invalid. The resolved `consumer_id` scopes history (API-03). Env-only, never committed; fail-fast at startup if `GEO_API_KEYS` is empty. (recommended; API-05, ROADMAP success criterion 4)

### Endpoints
- **D-04:** `POST /audit` — zod-validate `{ url: string (http/https), callback_url?: string }`. Normalize via `@geo/core normalizeUrl` → compute `url_hash`. **Dedup (API-04):** `@geo/db findRecentByUrlHash(hash, DEDUP_TTL)` → if a recent `done` (or in-flight `queued|running`) job exists, return its `{ job_id }` (cached) WITHOUT enqueuing. Else `insertJob({url, normalized_url, url_hash, consumer_id, callback_url})` → `{ job_id }` immediately (async; never blocks on the audit). `callback_url`, if present, is SSRF-validated at submit (see D-08) → **400** if it resolves to a private/blocked IP. (recommended; API-01/04)
- **D-05:** `GET /audit/{job_id}` — `getJob(id)`; return `{ status, score?, findings?, error_code? }` (score+findings only when `done`). **404** if not found or not owned by the authenticated consumer (no cross-consumer read). (recommended; API-02)
- **D-06:** `GET /audits` — `listJobs({ consumer_id, page, limit })`, paginated (query params `page`/`limit`, sane caps), scoped to the authenticated consumer. (recommended; API-03)
- **D-07:** `GET /healthz` — **deep** check: run `SELECT 1` through `@geo/db`; **200** `{ status:"ok", db:"ok" }` when reachable, **503** `{ status:"error", db:"error" }` when not. No auth. (recommended; API-06, success criterion 5)

### Webhook (API-08)
- **D-08:** `callback_url` is SSRF-checked with the SAME guard as audit URLs — reuse the `@geo/fetch` resolve-and-validate path. Checked TWICE: at **submit** (reject obviously-private → 400) and again at **fire time** (TOCTOU — re-validate the resolved IP before POSTing). **Delivery ownership:** a small `webhook.ts` delivery module (POSTs `{ job_id, status, score, findings }` via an SSRF-safe fetch, bounded timeout + a couple of retries, failures logged but NON-fatal to the job). It is invoked by the **worker** right after `completeJob`/terminal-`failJob` when the job has a `callback_url` — Phase 5 adds the module and wires the worker call (a minimal, additive change to `packages/worker`, analogous to Phase 4 adding `requeueJob` to `@geo/db`). (recommended; API-08)

### Cross-cutting
- **D-09:** Consistent JSON error envelope `{ error: <code>, message }`; 400 validation (zod), 401 auth, 404 not-found/not-owned, 503 health, 500 unexpected. Request-id/log line per request. (recommended)
- **D-10:** **Testing** — vitest via Hono `app.request()` (no real socket); DAL against **PGlite** (reuse Phase 3 harness). Cover: 401 on missing/invalid key (every protected route); POST happy path → `{job_id}`; dedup returns same job_id within TTL; GET poll returns done score+findings; cross-consumer GET → 404; `/audits` pagination + consumer scoping; `/healthz` 200 vs 503 (DB down); `/openapi.json` is valid OpenAPI 3.x + `/docs` 200; callback_url private-IP → 400 (reuse Phase 2 loopback/mock-resolver). Never mock the DAL or SSRF semantics. (recommended)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project / requirements
- `.planning/REQUIREMENTS.md` §API (API-01..08) + non-goals (Titanium out, sync endpoint out)
- `.planning/ROADMAP.md` — Phase 5 goal + 7 success criteria
- `.planning/PROJECT.md` — async job model, Bun+Hono decision

### Phase contracts consumed (read the barrels)
- `packages/db/src/index.ts` + `dal.ts` — `createAuditDal`: `insertJob`, `getJob`, `listJobs`, `findRecentByUrlHash`, (status/findings types). `getSql` for `/healthz`.
- `packages/fetch/src/index.ts` — the SSRF resolve-and-validate path reused for `callback_url` (D-08); the 10 error codes.
- `packages/core/src/index.ts` — `normalizeUrl` (+ url_hash basis).
- `packages/worker/src/` — where the webhook-delivery call is wired (D-08).

### Stack rules / templates
- Global rule 21 backend adapter (Bun+Hono → `@hono/zod-openapi` + `@scalar/hono-api-reference`; emits `/openapi.json` + `docs/api.md`; CI mode `backend`).
- `C:\Users\artic\GitHub\_templates\bun-hono-app\` — bootstrap reference.
- Global rule 16 escape: explicit project decision to use bearer keys, NOT Titanium (internal 2-consumer service).
- `~/.claude/architecture-preferences.md` — LISTEN/NOTIFY+SSE patterns (webhook delivery may later use NOTIFY; v1 fires inline from the worker).

### External
- Hono + `@hono/zod-openapi` + `@scalar/hono-api-reference` docs — researcher MUST confirm current API (createRoute, OpenAPIHono, Scalar mount) + Bun.serve before planning.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@geo/db` DAL already exposes `insertJob`/`getJob`/`listJobs`/`findRecentByUrlHash` — the API is mostly a thin typed HTTP surface over these. `audits` table already has `url_hash`, `callback_url`, `normalized_url` columns (Phase 3 D-06).
- `@geo/fetch` SSRF resolver — reused verbatim for callback_url validation.
- `@geo/core normalizeUrl` — submit-time normalization + dedup hash.
- Phase 3 PGlite harness — API tests run the real DAL.

### Established Patterns
- Workspace package layout + tsup dual build + vitest; env-only secrets with fail-fast assert (mirror `assertDatabaseUrl`).
- Structured typed contracts; SSRF discipline from Phase 2.

### Integration Points
- Phase 6 containerizes `@geo/api` + `@geo/worker` as Coolify services; `GEO_API_KEYS`/`DATABASE_URL` from env.
- Phase 7 cron POSTs `/audit`; ottolax + HOW are the two authenticated consumers.
</code_context>

<specifics>
## Specific Ideas

The API is deliberately thin: validation + auth + dedup + pagination over the already-correct Phase 3 DAL — no business logic leaks in. The two SSRF-relevant surfaces (audit URL handled by the worker; `callback_url` handled here) share ONE guard. Async-only: `POST /audit` returns a job_id in milliseconds and never blocks on the audit. The OpenAPI spec is generated from the same zod schemas that validate requests — one source of truth (rule 21).
</specifics>

<deferred>
## Deferred Ideas

- Idempotency keys on `POST /audit` → v2 OPS-02.
- Titanium licensing / multi-tenant billing → explicit ROADMAP non-goal (internal service).
- WebSocket/SSE result streaming → non-goal (polling + webhook suffice).
- Admin UI / GraphQL → non-goals (consumers own UIs; REST sufficient).
- Webhook delivery via LISTEN/NOTIFY decoupled dispatcher → v2; v1 fires inline from the worker post-completion.
- Containerization + cron + consumer wiring → Phases 6/7.
</deferred>

---

*Phase: 5-Bun+Hono API Layer*
*Context gathered: 2026-06-02 (auto-mode, YOLO defaults)*
