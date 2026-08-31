# Phase 5: Bun+Hono API Layer — Research

**Researched:** 2026-06-02
**Domain:** Bun + Hono + `@hono/zod-openapi` + `@scalar/hono-api-reference`, bearer auth middleware, SSRF-safe webhook delivery
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `packages/api/` (`@geo/api`) — Bun+Hono service; exports `app` for tests + `src/main.ts` Bun.serve entry. Mirrors `@geo/db` tsup/vitest conventions.
- **D-02:** `@hono/zod-openapi` (`createRoute` + zod) + `@scalar/hono-api-reference`. `/openapi.json` + `/docs`. `docs/api.md` generated + committed.
- **D-03:** Bearer API-key auth, NOT Titanium. Keys in `GEO_API_KEYS` env (token→consumer_id map). Middleware on all routes except `/healthz`, `/openapi.json`, `/docs`. 401 on missing/invalid. Fail-fast if env empty at startup.
- **D-04:** `POST /audit` — zod-validate url + callback_url?, normalizeUrl, url_hash, dedup via `findRecentByUrlHash`, insertJob → `{job_id}`. SSRF-check callback_url at submit → 400.
- **D-05:** `GET /audit/{job_id}` — `getJob`; 404 if not found OR not owned by consumer. score+findings only when done.
- **D-06:** `GET /audits` — `listJobs({consumer_id, page, limit})`; paginated; consumer-scoped.
- **D-07:** `GET /healthz` — deep DB check via `SELECT 1`; 200 ok / 503 error. No auth.
- **D-08:** Webhook delivery — `webhook.ts` module; invoked by worker after completeJob/failJob when `callbackUrl` present; SSRF-check at fire time (TOCTOU re-validate); bounded timeout + retries; non-fatal.
- **D-09:** JSON error envelope `{ error: <code>, message }`. 400/401/404/503/500.
- **D-10:** vitest + `app.request()` (no socket); DAL against PGlite (Phase 3 harness).

### Claude's Discretion
None stated — all decisions locked.

### Deferred Ideas (OUT OF SCOPE)
- Idempotency keys (`POST /audit`) → v2 OPS-02
- Titanium licensing → ROADMAP non-goal
- WebSocket/SSE streaming → non-goal
- Admin UI / GraphQL → non-goals
- Webhook via LISTEN/NOTIFY dispatcher → v2
- Containerization + cron + consumer wiring → Phases 6/7
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| API-01 | `POST /audit` validates input, returns `{job_id}` async | D-04; `insertJob` signature confirmed; `normalizeUrl` from `@geo/core` |
| API-02 | `GET /audit/{job_id}` returns status + score/findings on done | D-05; `getJob` returns full `AuditJob`; consumer_id ownership check |
| API-03 | `GET /audits` paginated history | D-06; `listJobs({limit, offset})` confirmed — needs `consumer_id` filter (see gap below) |
| API-04 | Dedup/caching within TTL | D-04; `findRecentByUrlHash(hash, ttlMs)` confirmed; covers queued+running+done |
| API-05 | All endpoints require bearer auth | D-03; Hono middleware pattern verified from template |
| API-06 | `GET /healthz` deep DB check | D-07; `getSql` from `@geo/db` confirmed |
| API-07 | `/openapi.json` + `/docs` (Scalar) per rule 21 | D-01/02; `app.doc31` + `Scalar` mount confirmed from template |
| API-08 | `callback_url` SSRF-checked; webhook fires on completion | D-08; `isBlockedIP` + `createSafeFetcher` reuse seam documented |
</phase_requirements>

---

## Summary

Phase 5 delivers a thin HTTP surface over the already-correct Phase 3 DAL. The `@geo/db` DAL exposes all required query methods with confirmed signatures. The `@geo/fetch` package exposes `isBlockedIP` (for fast submit-time IP check) and `createSafeFetcher` (for SSRF-safe fire-time POST). The bootstrap template at `_templates/bun-hono-app/` is a working `OpenAPIHono` + Scalar reference — pinned exact versions match what's on the npm registry today.

Two technical seams require planner attention: (1) the DAL's `listJobs` only takes `{limit, offset}` — no `consumer_id` column exists yet; the planner must decide whether to add a `consumer_id` column to `audits` (schema migration) or filter in application code (post-query filter, acceptable for internal 2-consumer service). (2) Webhook delivery ownership crosses into `packages/worker` — this is an additive `webhook.ts` module + a 3-line call site in `pipeline.ts` after `completeJob`/`failJob`, analogous to how Phase 4 added `requeueJob`.

**Primary recommendation:** Factory pattern `createApp({dal, fetcher, webhookSender?})` for all tests; `src/main.ts` wires production instances and calls `Bun.serve`.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Auth (bearer key validation) | API / Backend | — | Token secrets live in env; never client-side |
| Input validation + URL normalization | API / Backend | — | Zod + `@geo/core normalizeUrl` at the HTTP boundary |
| Dedup (url_hash TTL check) | Database / Storage | API (orchestrates) | `findRecentByUrlHash` is a DB query; API decides whether to insert |
| Job submission (`insertJob`) | Database / Storage | API (orchestrates) | Async; API returns job_id immediately |
| Polling (`getJob`) | Database / Storage | API (orchestrates) | Simple row fetch; consumer_id ownership enforced in API layer |
| Pagination (`listJobs`) | Database / Storage | API (orchestrates) | SQL LIMIT/OFFSET; consumer scoping must be enforced in API layer |
| Webhook delivery | Worker tier | API (module authored here) | Fires post-completion inside the worker process; `webhook.ts` lives in `packages/worker` |
| SSRF validation (callback_url) | API / Backend (submit) + Worker tier (fire) | — | Two check points: reject at intake; re-validate before POST |
| OpenAPI spec + Scalar UI | API / Backend | — | `OpenAPIHono.doc31` + Scalar mount; no separate build step |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `hono` | 4.12.23 | HTTP framework | Bun-native, first-class; used in `_templates/bun-hono-app` [VERIFIED: npm registry] |
| `@hono/zod-openapi` | 1.4.0 | `createRoute` + zod-driven OpenAPI 3.1 | Rule 21 backend adapter; confirmed in template [VERIFIED: npm registry] |
| `@scalar/hono-api-reference` | 0.10.20 | Scalar UI at `/docs` | Rule 21 backend adapter; confirmed in template [VERIFIED: npm registry] |
| `zod` | 4.4.3 (template) / project uses 3.x | Request/response validation | Same zod used across workspace [ASSUMED — check workspace root for pinned version] |

### Supporting (already in workspace)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@geo/db` | workspace:* | DAL (insertJob, getJob, listJobs, findRecentByUrlHash, getSql) | All data access |
| `@geo/fetch` | workspace:* | SSRF validation; `isBlockedIP`, `createSafeFetcher` | callback_url validation + webhook fire |
| `@geo/core` | workspace:* | `normalizeUrl` | URL normalization at submit |
| `vitest` | 4.1.8 (from @geo/db) | Test runner | Mirrors existing package convention |
| `tsup` | 8.5.1 (from @geo/db) | Dual ESM+CJS build | Mirrors existing package convention |

### Installation (new deps only)
```bash
# From packages/api/
bun add hono @hono/zod-openapi @scalar/hono-api-reference zod
bun add -d tsup vitest @types/bun typescript @electric-sql/pglite
```

**Note on zod version:** Template pins `zod@^4.4.3`; `@geo/db` does not declare zod as a direct dep. Check workspace root `package.json` for a pinned zod version before adding — use whatever version is already present to avoid dual-zod issues with `@hono/zod-openapi`. [ASSUMED — workspace root not checked]

---

## Package Legitimacy Audit

All packages below are from the official `_templates/bun-hono-app` bootstrap reference used by the project owner. slopcheck was not run (tool not available in this environment).

| Package | Registry | Age | Source Repo | Disposition |
|---------|----------|-----|-------------|-------------|
| `hono` | npm | ~4 yrs | github.com/honojs/hono | Approved — official framework, 600k+/wk downloads [ASSUMED: download count; VERIFIED: npm registry] |
| `@hono/zod-openapi` | npm | ~2 yrs | github.com/honojs/middleware | Approved — official Hono monorepo package [VERIFIED: npm registry] |
| `@scalar/hono-api-reference` | npm | ~2 yrs | github.com/scalar/scalar | Approved — official Scalar monorepo package [VERIFIED: npm registry] |
| `zod` | npm | ~5 yrs | github.com/colinhacks/zod | Approved — industry standard [VERIFIED: npm registry] |

*slopcheck unavailable — all tagged [ASSUMED] for download counts. Packages are from the owner's own bootstrap template, minimizing hallucination risk.*

---

## Architecture Patterns

### System Architecture Diagram

```
Consumer (Bearer token)
        │
        ▼
  ┌─────────────────────────────────────┐
  │  Hono middleware stack              │
  │  ┌──────────────────────────────┐   │
  │  │  bearerAuth (all except      │   │
  │  │  /healthz, /openapi.json,    │   │
  │  │  /docs) → 401 or ctx.set     │   │
  │  │  ('consumer_id', id)         │   │
  │  └──────────────────────────────┘   │
  │  ┌──────────────────────────────┐   │
  │  │  requestId / structured log  │   │
  │  └──────────────────────────────┘   │
  └─────────────────────────────────────┘
        │
    Route dispatch
   ┌────┴──────────────────────────────────────┐
   │                                           │
POST /audit                            GET /audit/{id}
   │                                           │
normalizeUrl → url_hash                  getJob(id)
   │                                       │
findRecentByUrlHash(hash, TTL)         consumer_id check
   │ HIT → return {job_id}              │
   │ MISS ↓                          {status, score?, findings?}
SSRF-check callback_url                    │
   │ BLOCKED → 400                    404 if not owned
insertJob → {job_id}                       │
   │                                   200
   200                                     │
   │                                       ▼
   ▼                               GET /audits
   ▼                               listJobs({consumer_id, limit, offset})
   ▼                                       │
   ▼                                   paginated []
   ▼
Worker (separate process)
   └─ completeJob / failJob
         │
         ├─ callbackUrl present?
         │       YES → webhook.ts
         │              re-SSRF-validate
         │              POST {job_id, status, score, findings}
         │              bounded timeout + retries
         │              non-fatal (log on failure)
         └─ callbackUrl absent → done

GET /healthz → getSql() → SELECT 1 → 200/503
GET /openapi.json → app.doc31(...)
GET /docs → Scalar({ url: '/openapi.json' })
```

### Recommended Project Structure
```
packages/api/
├── src/
│   ├── app.ts           # createApp({dal, fetcher}) factory → OpenAPIHono instance
│   ├── main.ts          # Bun.serve entry; wires production DAL/fetcher, calls createApp
│   ├── middleware/
│   │   └── auth.ts      # bearerAuth middleware; GEO_API_KEYS parsing; consumer_id ctx
│   ├── routes/
│   │   ├── audit-post.ts   # POST /audit
│   │   ├── audit-get.ts    # GET /audit/{job_id}
│   │   ├── audits-list.ts  # GET /audits
│   │   └── healthz.ts      # GET /healthz
│   └── __tests__/
│       ├── auth.test.ts
│       ├── audit-post.test.ts
│       ├── audit-get.test.ts
│       ├── audits-list.test.ts
│       └── healthz.test.ts
├── docs/
│   └── api.md           # generated from /openapi.json (rule 21)
├── package.json
├── tsup.config.ts
└── vitest.config.ts

packages/worker/src/
└── webhook.ts           # NEW: deliverWebhook(job, fetcher) — called from pipeline.ts
```

### Pattern 1: OpenAPIHono createRoute (from official template)
**What:** Every route uses `createRoute` — never plain `app.get/post` which bypasses the OpenAPI registry.
**When to use:** All routes.
```typescript
// Source: _templates/bun-hono-app/src/routes/example.ts
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

const postAuditRoute = createRoute({
  method: 'post',
  path: '/audit',
  tags: ['audit'],
  summary: 'Submit URL for GEO audit',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            url: z.string().url(),
            callback_url: z.string().url().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ job_id: z.string() }) } },
      description: 'Job queued (or dedup hit)',
    },
    400: {
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
      description: 'Validation error or SSRF-blocked callback_url',
    },
    401: {
      content: { 'application/json': { schema: z.object({ error: z.string(), message: z.string() }) } },
      description: 'Missing or invalid bearer token',
    },
  },
});
```

### Pattern 2: OpenAPIHono bearer security scheme registration
**What:** Register the scheme once on the app; all routes reference it via `security: [{BearerAuth: []}]`.
```typescript
// Source: @hono/zod-openapi docs (ASSUMED — confirm exact API before coding)
app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
  type: 'http',
  scheme: 'bearer',
});
// Or via doc31 options:
app.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: { title: '@geo/api', version: '0.1.0' },
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer' },
    },
  },
});
```
[ASSUMED — exact method for global security scheme registration needs verification against `@hono/zod-openapi` 1.4.0 docs; the component approach shown above is the OpenAPI 3.1 spec pattern]

### Pattern 3: Factory app for testability
**What:** `createApp` accepts deps; `main.ts` provides prod instances; tests inject PGlite-backed DAL.
```typescript
// src/app.ts
export interface AppDeps {
  dal: AuditDal;
  fetcher: ReturnType<typeof createSafeFetcher>;
}

export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  // register middleware, routes, doc31, Scalar
  return app;
}
```

```typescript
// src/main.ts (Bun.serve entry)
import { createApp } from './app.js';
import { getDefaultDal } from '@geo/db';
import { createSafeFetcher } from '@geo/fetch';

const app = createApp({ dal: getDefaultDal(), fetcher: createSafeFetcher() });
export default { port: Number(process.env.PORT ?? 8080), fetch: app.fetch };
```

```typescript
// test helper
const dal = createAuditDal(makePgliteExecutor(db));
const app = createApp({ dal, fetcher: createSafeFetcher({ resolver: mockResolver }) });
const res = await app.request('/audit', { method: 'POST', ... });
```

### Pattern 4: Auth middleware
```typescript
// src/middleware/auth.ts
const EXEMPT = new Set(['/healthz', '/openapi.json', '/docs']);

export function bearerAuth(apiKeys: Map<string, string>) {
  return createMiddleware(async (c, next) => {
    if (EXEMPT.has(c.req.path)) return next();
    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const consumerId = token ? apiKeys.get(token) : null;
    if (!consumerId) {
      return c.json(
        { error: 'unauthorized', message: 'Missing or invalid API key' },
        401,
        { 'WWW-Authenticate': 'Bearer realm="geo-api"' },
      );
    }
    c.set('consumer_id', consumerId);
    return next();
  });
}

// Fail-fast at startup
export function parseApiKeys(raw: string | undefined): Map<string, string> {
  if (!raw) throw new Error('GEO_API_KEYS env var is required');
  // format: token1:consumer1,token2:consumer2
  // or JSON: {"token1":"consumer1"}
  // choose one format and document in .env.example
  ...
}
```

### Pattern 5: `app.request()` test (no socket)
```typescript
// vitest test — no Bun.serve needed
import { describe, it, expect } from 'vitest';

describe('POST /audit', () => {
  it('returns 401 without token', async () => {
    const res = await app.request('/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(res.status).toBe(401);
  });
});
```
[VERIFIED: confirmed via `_templates/bun-hono-app` + Hono official docs pattern]

### Anti-Patterns to Avoid
- **Plain `app.get/post`:** bypasses OpenAPI registry; `/openapi.json` will be incomplete. Always use `app.openapi(createRoute(...), handler)`.
- **Mocking the DAL in tests:** D-10 explicitly prohibits DAL mocking — use real PGlite.
- **Module-level singleton DAL in `app.ts`:** breaks test isolation; use factory pattern.
- **Forgetting `consumer_id` scoping on `listJobs`:** the current `listJobs` DAL signature is `({limit, offset})` only — see gap below.
- **Single SSRF check only at submit:** TOCTOU — DNS can change between submit and fire; re-validate at fire time (D-08).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OpenAPI spec maintenance | Hand-edited JSON/YAML | `@hono/zod-openapi` `createRoute` | Zod schemas ARE the spec; single source of truth |
| API docs UI | Custom HTML | `@scalar/hono-api-reference` | Scalar: zero-config, rule 21 compliant |
| SSRF IP classification | Custom IP range parser | `@geo/fetch isBlockedIP` | Handles IPv4/IPv6/mapped/obfuscated forms; Phase 2 hardened |
| SSRF-safe HTTP POST (webhook fire) | `fetch(callbackUrl, ...)` directly | `createSafeFetcher` + re-validate | Bypasses the pinned-IP/re-validate path; TOCTOU risk |
| Schema validation | Manual `typeof` checks | Zod in `createRoute` | Automatic 400 from `@hono/zod-openapi` |

---

## Critical Gap: `listJobs` consumer_id scoping (API-03 / D-06)

**What the CONTEXT says:** `listJobs({ consumer_id, page, limit })` — consumer-scoped.

**What the DAL actually has:**
```typescript
async listJobs(pagination: PaginationInput): Promise<AuditJob[]>
// PaginationInput = { limit: number; offset: number }
```
The `audits` table currently has no `consumer_id` column (confirmed from `dal.ts` INSERT: only `url, normalized_url, url_hash, callback_url`). The `AuditJob` type also has no `consumerId` field.

**Impact:** To implement consumer-scoped history you must either:
1. **Add `consumer_id` column** to `audits` (schema migration in Phase 3/5), update `insertJob` to accept it, update `listJobs` to filter by it, update `getJob` cross-consumer check. This is the correct approach for multi-consumer isolation and aligns with D-05 ("404 if not owned by authenticated consumer").
2. **Post-query filter in API:** `getJob` returns all jobs; filter by `callbackUrl` or some other field — **not viable** since there's no consumer marker in the schema.

**Recommendation for planner:** Option 1 is required. `Wave 0` must include:
- Migration `0002_add_consumer_id.sql`: `ALTER TABLE audits ADD COLUMN consumer_id TEXT NOT NULL DEFAULT ''` (or nullable for backward compat with existing Phase 3 rows)
- Update `InsertJobInput` + `AuditJob` types to include `consumer_id`
- Update `insertJob` SQL to include `consumer_id`
- Update `listJobs` to accept and filter by `consumer_id`
- Update `getJob` to return `consumerId` for ownership check in the API layer

This is additive to `@geo/db` — Phase 5 owns this migration since it's the first consumer of the field.

---

## SSRF Reuse Seam Analysis

### At submit time (validate callback_url, no POST)

`@geo/fetch` exports `isBlockedIP` directly. For a fast hostname-only check:
```typescript
import { isBlockedIP } from '@geo/fetch';
import { dns } from 'node:dns/promises';

async function validateCallbackUrl(raw: string): Promise<'ok' | 'blocked'> {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return 'blocked'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'blocked';
  const ips = await dns.resolve4(parsed.hostname).catch(() => []);
  // also resolve6
  if (ips.length === 0) return 'blocked';  // DNS failure → deny
  if (ips.some(ip => isBlockedIP(ip))) return 'blocked';
  return 'ok';
}
```

However, `dns-resolve.js` in `@geo/fetch` is NOT exported from `@geo/fetch`'s barrel. Only `isBlockedIP`, `createSafeFetcher`, `FetchErrorCode`, `buildErrorResult` are public. The `resolveAndValidate` function (which handles all A+AAAA records and IPv4-mapped IPv6) is internal.

**Cleaner seam:** Use `createSafeFetcher` with a custom dispatcher that does NOT actually connect — but this is awkward. Better: the planner should consider **exporting `resolveAndValidate` from `@geo/fetch`**, or creating a thin `validateUrlForWebhook(raw)` helper in `@geo/fetch` that reuses the internal validation path without making a network request. This is a small additive export.

**Until then:** At submit, use `isBlockedIP` + manual A/AAAA resolve (acceptable for v1; logs any bypass risk). At fire time, use `createSafeFetcher` which re-validates inside its loop.

### At fire time (webhook.ts in packages/worker)

Use `createSafeFetcher` with a short `timeoutMs`. The safeFetcher already re-resolves DNS on each call — TOCTOU handled.

```typescript
// packages/worker/src/webhook.ts
import { createSafeFetcher } from '@geo/fetch';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;

export async function deliverWebhook(
  callbackUrl: string,
  payload: { job_id: string; status: string; score: number | null; findings: unknown },
): Promise<void> {
  // SSRF-safe fetcher: re-validates DNS on each call
  const fetcher = createSafeFetcher({ timeoutMs: DEFAULT_TIMEOUT_MS });
  // NOTE: createSafeFetcher returns a GET fetcher — for POST we need a different approach.
  // See Pitfall 1 below.
}
```

**Pitfall: `createSafeFetcher` only does GET.** The `Fetcher` type in `@geo/core` is `(url: string) => Promise<FetchResult>` — a GET fetcher. For webhook delivery (POST with JSON body) we need a different calling pattern. Options:
1. **Export a `createSafeRequester` factory** from `@geo/fetch` that accepts method + body (additive, clean).
2. **Use `isBlockedIP` + manual undici POST** after resolving and checking all IPs — replicates the pinned-IP pattern manually.
3. **Duplicate minimal validation** in `webhook.ts` — violates DRY but keeps worker self-contained.

**Recommendation for planner:** Add a `createSafeRequester` (or `validateAndPost`) export to `@geo/fetch` as a Wave 0 task in Phase 5. This is the correct SSRF-discipline approach and prevents code duplication.

---

## Dedup Semantics (`findRecentByUrlHash`)

From DAL source:
```sql
SELECT * FROM audits
WHERE url_hash = $1
  AND created_at > now() - ($2::numeric * interval '1 second')
ORDER BY created_at DESC
LIMIT 1
```

**Key observations:**
- TTL window is based on `created_at`, not `finished_at` — a job submitted 23h ago counts even if it's still running.
- The query returns ANY status (`queued`, `running`, `done`, `failed`). The API must decide which statuses constitute a "dedup hit". Based on D-04: "a recent `done` (or in-flight `queued|running`) job" — so `failed` jobs should NOT dedup (re-submit allowed on failure).
- **Application-layer filter needed:** after `findRecentByUrlHash` returns a job, check `job.status !== 'failed'` before treating it as a dedup hit. If `failed`, proceed with `insertJob`.
- `consumer_id` is NOT factored into the dedup query — a job by consumer A will dedup a request from consumer B for the same URL within TTL. This may be intentional (same URL = same result regardless of consumer) — planner should confirm.

---

## Webhook Delivery Wiring in `packages/worker`

D-08 states: "invoked by the worker right after `completeJob`/terminal-`failJob` when the job has a `callback_url`."

The clean insertion point in `pipeline.ts` is after line 158 (`dal.completeJob(...)` success path) and after each `dal.failJob(...)` call:

```typescript
// pipeline.ts — after completeJob:
const ok = await dal.completeJob(job.id, job.leaseToken!, scored.score, merged);
if (!ok) console.warn(...);
// ADD: webhook delivery
if (job.callbackUrl && ok) {
  await deliverWebhook(job.callbackUrl, { job_id: job.id, status: 'done', score: scored.score, findings: merged })
    .catch(err => console.warn('[pipeline] webhook delivery failed:', err));
}
```

There are 3 `failJob` call sites in `pipeline.ts` (lines ~82, ~134, ~143) — each needs the same non-fatal webhook call. Consider a helper `tryDeliverWebhook(job, status)` to DRY these up.

**Worker.ts** does not need changes — `runAudit` calls `pipeline.ts` which owns the webhook call.

---

## Common Pitfalls

### Pitfall 1: createSafeFetcher is GET-only
**What goes wrong:** Using `createSafeFetcher` directly for webhook POST — it builds a GET request with no body support.
**Why it happens:** `Fetcher` type is `(url: string) => Promise<FetchResult>`, designed for page fetching.
**How to avoid:** Add `createSafeRequester` export to `@geo/fetch` that wraps the same `validateUrl` + pinned-IP undici path but with configurable method + body. Or implement the undici pinned-POST inline in `webhook.ts` after calling `resolveAndValidate` (requires exporting it).
**Warning signs:** TypeScript accepts `fetcher(callbackUrl)` but the webhook consumer will receive a GET, not a POST.

### Pitfall 2: Plain `app.get/post` routes bypass OpenAPI registry
**What goes wrong:** `/openapi.json` is missing the route; D-02 violated; rule 21 CI will fail.
**Why it happens:** Hono allows both `app.get(...)` and `app.openapi(createRoute(...), ...)`.
**How to avoid:** Lint rule or code review convention: only `app.openapi()` in route files.
**Warning signs:** `/openapi.json` paths object is missing a route you implemented.

### Pitfall 3: `listJobs` not consumer-scoped without schema change
**What goes wrong:** All consumers see all jobs; cross-consumer data leak.
**Why it happens:** `audits` table has no `consumer_id` column.
**How to avoid:** Schema migration (Wave 0 of Phase 5) adding `consumer_id`.

### Pitfall 4: `zod` version mismatch
**What goes wrong:** `@hono/zod-openapi` 1.4.0 may pin a specific zod peer. If workspace uses zod v3 but template/`@hono/zod-openapi` expects v4, type errors arise.
**Why it happens:** Zod v3→v4 is a breaking change (API surface differs).
**How to avoid:** Check `npm view @hono/zod-openapi peerDependencies` before installing; align workspace zod version.
**Warning signs:** TypeScript errors on `.url()`, `.optional()` or `z.object()` schema calls.

### Pitfall 5: Bearer token in query param / missing WWW-Authenticate
**What goes wrong:** 401 response missing `WWW-Authenticate: Bearer realm="..."` — some clients (curl, spec validators) treat this as a non-standard 401.
**Why it happens:** Hono's `c.json({...}, 401)` doesn't auto-add the header.
**How to avoid:** Middleware explicitly sets the header: `c.header('WWW-Authenticate', 'Bearer realm="geo-api"')` before returning 401.

### Pitfall 6: `findRecentByUrlHash` returns `failed` jobs as dedup hits
**What goes wrong:** A previously-failed job causes every subsequent request for the same URL to return the failed job_id rather than queueing a new audit.
**Why it happens:** The DAL query does not filter by status.
**How to avoid:** Application-layer check: `if (recent && recent.status !== 'failed')` → dedup; else insert.

---

## Code Examples

### Healthz route (deep DB check)
```typescript
// Source: pattern from @geo/db getSql export
import { getSql } from '@geo/db';

const healthzRoute = createRoute({
  method: 'get',
  path: '/healthz',
  tags: ['system'],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ status: z.literal('ok'), db: z.literal('ok') }) } }, description: 'Healthy' },
    503: { content: { 'application/json': { schema: z.object({ status: z.literal('error'), db: z.literal('error') }) } }, description: 'Unhealthy' },
  },
});

app.openapi(healthzRoute, async (c) => {
  try {
    const sql = getSql();
    await sql.unsafe('SELECT 1');
    return c.json({ status: 'ok' as const, db: 'ok' as const }, 200);
  } catch {
    return c.json({ status: 'error' as const, db: 'error' as const }, 503);
  }
});
```

### GEO_API_KEYS env format recommendation
```
# .env.example
# Comma-separated token:consumer_id pairs
GEO_API_KEYS=sk-abc123:ottolax,sk-def456:hyperoptimizedwebsites
```
This is simpler than JSON for a 2-consumer internal service. Fail-fast at startup if missing.

---

## Validation Architecture

> `workflow.nyquist_validation` not set to false — section required.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.8 (mirrors @geo/db) |
| Config file | `packages/api/vitest.config.ts` (Wave 0 gap) |
| Quick run command | `bun run test` from `packages/api/` |
| Full suite command | `bun run test` (all tests, no filter) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| API-01 | POST /audit returns {job_id} | unit | `vitest run src/__tests__/audit-post.test.ts` | ❌ Wave 0 |
| API-01 | POST /audit async — does not block | unit | same file | ❌ Wave 0 |
| API-02 | GET /audit/{id} returns status+findings when done | unit | `vitest run src/__tests__/audit-get.test.ts` | ❌ Wave 0 |
| API-02 | GET /audit/{id} 404 for wrong consumer | unit | same file | ❌ Wave 0 |
| API-03 | GET /audits paginated, consumer-scoped | unit | `vitest run src/__tests__/audits-list.test.ts` | ❌ Wave 0 |
| API-04 | Dedup returns same job_id within TTL (done+running+queued) | unit | audit-post.test.ts | ❌ Wave 0 |
| API-04 | Dedup does NOT hit failed jobs | unit | audit-post.test.ts | ❌ Wave 0 |
| API-05 | 401 on missing token (every protected route) | unit | `vitest run src/__tests__/auth.test.ts` | ❌ Wave 0 |
| API-05 | 401 on invalid token | unit | auth.test.ts | ❌ Wave 0 |
| API-05 | /healthz, /openapi.json, /docs exempt from auth | unit | auth.test.ts | ❌ Wave 0 |
| API-06 | /healthz 200 {status:ok,db:ok} when DB up | unit | `vitest run src/__tests__/healthz.test.ts` | ❌ Wave 0 |
| API-06 | /healthz 503 when DB down | unit | healthz.test.ts (PGlite closed or broken) | ❌ Wave 0 |
| API-07 | /openapi.json is valid OpenAPI 3.1 (has paths, components.securitySchemes) | unit | `vitest run src/__tests__/openapi.test.ts` | ❌ Wave 0 |
| API-07 | /docs returns 200 | unit | openapi.test.ts | ❌ Wave 0 |
| API-08 | POST /audit with loopback callback_url → 400 | unit | audit-post.test.ts (mock resolver or real loopback) | ❌ Wave 0 |
| API-08 | POST /audit with RFC1918 callback_url → 400 | unit | audit-post.test.ts | ❌ Wave 0 |

### What Defers to Phase 6 (live deploy)
- Real DATABASE_URL round-trip (tests use PGlite)
- Real DNS resolution for callback_url SSRF (tests use injectable mock resolver from `@geo/fetch`)
- HTTPS TLS in Bun.serve (Phase 6 containerizes with Coolify terminating TLS)
- End-to-end webhook delivery to a real external URL

### Wave 0 Gaps
- [ ] `packages/api/vitest.config.ts` — test runner config
- [ ] `packages/api/src/__tests__/pglite-helper.ts` — PGlite setup (reuse Phase 3 harness pattern from `@geo/db`)
- [ ] `packages/api/src/__tests__/auth.test.ts`
- [ ] `packages/api/src/__tests__/audit-post.test.ts`
- [ ] `packages/api/src/__tests__/audit-get.test.ts`
- [ ] `packages/api/src/__tests__/audits-list.test.ts`
- [ ] `packages/api/src/__tests__/healthz.test.ts`
- [ ] `packages/api/src/__tests__/openapi.test.ts`

---

## Environment Availability

Step 2.6: SKIPPED for this research phase (no new external tool dependencies; all deps are npm packages + PGlite for tests). Bun is assumed available (existing packages run via `bun`). DATABASE_URL from Coolify env (Phase 6).

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer token middleware; `GEO_API_KEYS` env map |
| V3 Session Management | no | Stateless API; no sessions |
| V4 Access Control | yes | consumer_id scoping on /audit/{id} and /audits |
| V5 Input Validation | yes | Zod via `@hono/zod-openapi` createRoute |
| V6 Cryptography | no | No crypto operations in this phase |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSRF via callback_url | Tampering/Elevation | `isBlockedIP` + re-validate at fire time |
| Cross-consumer data access | Information Disclosure | consumer_id ownership check in getJob; listJobs filter |
| API key in URL params | Information Disclosure | Bearer header only; reject query-param tokens |
| Timing attack on token comparison | Information Disclosure | Use `crypto.timingSafeEqual` in auth middleware |
| Bearer token logging | Information Disclosure | Never log Authorization header; log request-id only |
| Dedup returning another consumer's job | Information Disclosure | See Gap above — dedup is currently cross-consumer; planner must decide policy |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | zod version in workspace — template uses v4.4.3 but @geo/db may use v3 | Standard Stack | Type errors; `@hono/zod-openapi` peer dep mismatch |
| A2 | `app.doc31` second arg accepts `components.securitySchemes` directly | Pattern 2 | Security scheme not registered in spec; 401 responses lack spec backing |
| A3 | `findRecentByUrlHash` dedup is intended to be cross-consumer (same URL = same result) | Dedup Semantics | Data isolation concern if consumers expect per-consumer dedup |
| A4 | `consumer_id` column is needed (not yet in schema) | Critical Gap | Without migration, consumer scoping cannot be implemented |
| A5 | `@hono/zod-openapi` 1.4.0 is Bun-compatible without polyfills | Standard Stack | Runtime errors at Bun.serve start |

---

## Open Questions

1. **consumer_id in audits schema**
   - What we know: Column does not exist; `listJobs` and `getJob` have no consumer filter.
   - What's unclear: Whether Phase 5 owns this migration or it's considered a Phase 3 gap.
   - Recommendation: Phase 5 owns it — add `0002_add_consumer_id.sql` as Wave 0 task.

2. **SSRF-safe POST for webhook delivery**
   - What we know: `createSafeFetcher` only does GET; no `createSafeRequester` exists.
   - What's unclear: Whether to add a new export to `@geo/fetch` or implement inline in `webhook.ts`.
   - Recommendation: Add `validateAndPost(url, body, options)` to `@geo/fetch` barrel — clean separation of SSRF concern.

3. **Dedup cross-consumer policy**
   - What we know: `findRecentByUrlHash` query has no consumer filter.
   - What's unclear: Whether two consumers auditing the same URL should share a cached result.
   - Recommendation: For v1 (internal 2-consumer), cross-consumer dedup is acceptable and simplifies the schema. Document explicitly.

4. **GEO_API_KEYS format**
   - What we know: D-03 says "JSON/CSV map of token → consumer_id".
   - What's unclear: Exact wire format (JSON object vs CSV `token:id` pairs).
   - Recommendation: CSV `token:consumer_id,token2:consumer2` — simpler to set in Coolify env vars than escaped JSON.

---

## Sources

### Primary (HIGH confidence)
- `_templates/bun-hono-app/` — working `OpenAPIHono` + Scalar mount; exact package versions
- `packages/db/src/dal.ts` — confirmed DAL signatures
- `packages/db/src/types.ts` — confirmed type shapes
- `packages/fetch/src/index.ts` — confirmed public exports
- `packages/fetch/src/safe-fetcher.ts` — confirmed GET-only design
- `packages/worker/src/pipeline.ts` — confirmed webhook insertion points
- npm registry — hono@4.12.23, @hono/zod-openapi@1.4.0, @scalar/hono-api-reference@0.10.20 [VERIFIED: npm registry]

### Secondary (MEDIUM confidence)
- `@hono/zod-openapi` README patterns (ASSUMED from training + template evidence)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions confirmed from template + npm registry
- DAL contracts: HIGH — read from source
- Architecture patterns: HIGH — from working template
- SSRF seam analysis: HIGH — read from source (GET-only gap is a concrete finding)
- Security scheme registration API: MEDIUM — template doesn't show it; exact method needs doc check

**Research date:** 2026-06-02
**Valid until:** 2026-07-02 (stable ecosystem; Hono/Scalar release cadence is moderate)

---

## RESEARCH COMPLETE

**Phase:** 5 — Bun+Hono API Layer
**Confidence:** HIGH

### Key Findings
- All locked decisions (D-01..D-10) are technically sound and buildable as-stated with one exception: `listJobs` requires a `consumer_id` column in `audits` (schema gap; Wave 0 migration needed).
- `createSafeFetcher` is GET-only — webhook POST delivery requires either a new `validateAndPost` export from `@geo/fetch` or manual undici POST with `isBlockedIP` check. Planner must assign this as a Wave 0 task.
- `findRecentByUrlHash` returns any status including `failed` — API must filter `status !== 'failed'` before treating result as dedup hit.
- Bootstrap template confirms exact API: `OpenAPIHono`, `createRoute`, `app.openapi()`, `app.doc31()`, `Scalar({url})` — no surprises.
- Webhook wiring in `pipeline.ts` is straightforward: 3–4 additive call sites after `completeJob`/`failJob`; no structural worker changes needed.

### Files Created
`.planning/phases/05-bun-hono-api-layer/05-RESEARCH.md`

### Ready for Planning
Planner can proceed. Wave 0 must include: `consumer_id` migration, `createSafeRequester` export in `@geo/fetch`, package scaffold, and test harness setup.
