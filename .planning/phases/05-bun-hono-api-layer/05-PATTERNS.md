# Phase 5: Bun+Hono API Layer — Pattern Map

**Mapped:** 2026-06-02
**Files analyzed:** 18 (new/modified)
**Analogs found:** 18 / 18

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/api/package.json` | config | — | `packages/db/package.json` | exact |
| `packages/api/tsup.config.ts` | config | — | `packages/db/tsup.config.ts` | exact |
| `packages/api/vitest.config.ts` | config | — | `packages/db/vitest.config.ts` | exact |
| `packages/api/src/app.ts` | service (factory) | request-response | `_templates/bun-hono-app/src/index.ts` | role-match |
| `packages/api/src/main.ts` | service (entry) | request-response | `_templates/bun-hono-app/src/index.ts` | exact |
| `packages/api/src/middleware/auth.ts` | middleware | request-response | `packages/db/src/client.ts` (fail-fast pattern) | partial |
| `packages/api/src/routes/audit-post.ts` | route/controller | request-response | `_templates/bun-hono-app/src/routes/example.ts` | exact |
| `packages/api/src/routes/audit-get.ts` | route/controller | request-response | `_templates/bun-hono-app/src/routes/example.ts` | exact |
| `packages/api/src/routes/audits-list.ts` | route/controller | CRUD | `_templates/bun-hono-app/src/routes/example.ts` | role-match |
| `packages/api/src/routes/healthz.ts` | route/controller | request-response | `_templates/bun-hono-app/src/index.ts` (health route) | exact |
| `packages/api/src/__tests__/pglite-helper.ts` | test utility | — | `packages/db/src/__tests__/harness.ts` | exact |
| `packages/api/src/__tests__/auth.test.ts` | test | request-response | `packages/db/src/__tests__/harness.test.ts` | role-match |
| `packages/api/src/__tests__/audit-post.test.ts` | test | request-response | `packages/db/src/__tests__/lifecycle.test.ts` | role-match |
| `packages/api/src/__tests__/audit-get.test.ts` | test | request-response | `packages/db/src/__tests__/lifecycle.test.ts` | role-match |
| `packages/api/src/__tests__/audits-list.test.ts` | test | CRUD | `packages/db/src/__tests__/lifecycle.test.ts` | role-match |
| `packages/api/src/__tests__/healthz.test.ts` | test | request-response | `packages/db/src/__tests__/harness.test.ts` | role-match |
| `packages/db/migrations/0002_add_consumer_id.sql` | migration | — | `packages/db/migrations/0001_create_audits.sql` | exact |
| `packages/db/src/dal.ts` (extend) | service | CRUD | self (existing `insertJob`/`listJobs`/`getJob`) | exact |
| `packages/db/src/types.ts` (extend) | model | — | self (existing `InsertJobInput`/`PaginationInput`) | exact |
| `packages/fetch/src/index.ts` (extend barrel) | utility | — | self (existing exports) | exact |
| `packages/fetch/src/safe-requester.ts` (new) | utility | request-response | `packages/fetch/src/safe-fetcher.ts` | exact |
| `packages/worker/src/webhook.ts` (new) | service | event-driven | `packages/worker/src/pipeline.ts` (deps pattern) | role-match |
| `packages/worker/src/pipeline.ts` (extend) | service | event-driven | self (completeJob/failJob call sites lines 82,134,143,158) | exact |

---

## Pattern Assignments

### `packages/api/package.json` (config)

**Analog:** `packages/db/package.json`

Mirror this exactly — same exports shape, same scripts, same dev-dep versions. Key differences for `@geo/api`:
- Name: `@geo/api`
- No `migrations` in `files`
- Add `"bin": { "geo-api": "./dist/main.js" }` (mirror worker)
- Dependencies: `hono`, `@hono/zod-openapi`, `@scalar/hono-api-reference`, `zod@^3.25`, workspace peers
- **Critical (D-14):** use `zod@^3.25.51` (NOT template's `^4.4.3`) to match workspace pin

**Exact versions to mirror** (`packages/db/package.json`):
```json
{
  "devDependencies": {
    "@electric-sql/pglite": "0.5.1",
    "@types/node": "25.9.1",
    "tsup": "8.5.1",
    "typescript": "6.0.3",
    "vitest": "4.1.8"
  }
}
```

**Template versions** (`_templates/bun-hono-app/package.json`):
```json
{
  "dependencies": {
    "hono": "^4.12.23",
    "@hono/zod-openapi": "^1.4.0",
    "@scalar/hono-api-reference": "^0.10.19"
  }
}
```

---

### `packages/api/tsup.config.ts` (config)

**Analog:** `packages/db/tsup.config.ts` (lines 1-10) — copy verbatim.

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
});
```

Add a second entry for the Bun.serve entrypoint: `entry: ["src/index.ts", "src/main.ts"]`.

---

### `packages/api/vitest.config.ts` (config)

**Analog:** `packages/db/vitest.config.ts` (lines 1-9) — copy verbatim.

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    watch: false,
  },
});
```

---

### `packages/api/src/main.ts` (service entry, request-response)

**Analog:** `_templates/bun-hono-app/src/index.ts` (lines 1-50)

**Core pattern** (lines 1-50):
```typescript
// _templates/bun-hono-app/src/index.ts lines 1-50
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';

// app.doc31 + Scalar mount — REQUIRED rule 21
app.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'bun-hono-app', version: '0.1.0' },
});
app.get('/docs', Scalar({ url: '/openapi.json', theme: 'default' }));

const port = Number(process.env.PORT ?? 3000);
export default { port, fetch: app.fetch };
```

**Adaptation for `main.ts`:** wire production `createAuditDal(makePgExecutor(getSql()))` and `createSafeFetcher()`, call `createApp({dal, fetcher})`, then `export default { port, fetch: app.fetch }`. Fail-fast env check before `Bun.serve`.

---

### `packages/api/src/app.ts` (service factory, request-response)

**Analog:** `_templates/bun-hono-app/src/index.ts` (full file) + RESEARCH.md Pattern 3

**Factory pattern** (RESEARCH.md Pattern 3):
```typescript
// createApp factory — lets tests inject PGlite-backed DAL
import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { AuditDal } from '@geo/db';

export interface AppDeps {
  dal: AuditDal;
  fetcher: ReturnType<typeof createSafeFetcher>;
}

export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  // register middleware
  // register routes via app.route('/', ...)
  // app.doc31(...)
  // app.get('/docs', Scalar({...}))
  return app;
}
```

**Never use** `app.get/post` — always `app.openapi(createRoute(...), handler)` per template comment in `_templates/bun-hono-app/src/routes/example.ts` line 3.

---

### `packages/api/src/middleware/auth.ts` (middleware, request-response)

**Analog (fail-fast pattern):** `packages/db/src/client.ts` (lines 22-32)

```typescript
// packages/db/src/client.ts lines 22-32 — fail-fast guard to mirror
export function getSql(): Sql {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "@geo/db: DATABASE_URL is required but not set. " +
        "Set DATABASE_URL in your environment (see .env.example). " +
        "Do not include a real connection string in any committed file.",
    );
  }
  // ...
}
```

**Apply same pattern for `GEO_API_KEYS`:**
```typescript
export function parseApiKeys(raw: string | undefined): Map<string, string> {
  if (!raw) {
    throw new Error(
      "@geo/api: GEO_API_KEYS is required but not set. " +
        "Set GEO_API_KEYS in your environment (see .env.example). " +
        "Format: token1:consumer1,token2:consumer2"
    );
  }
  // CSV parse: "tok:id,tok2:id2"
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const [token, consumerId] = pair.trim().split(':');
    if (token && consumerId) map.set(token, consumerId);
  }
  if (map.size === 0) throw new Error("@geo/api: GEO_API_KEYS parsed to empty map");
  return map;
}
```

**Auth middleware pattern** (RESEARCH.md Pattern 4):
- Exempt set: `new Set(['/healthz', '/openapi.json', '/docs'])`
- `Authorization: Bearer <token>` → `apiKeys.get(token)` → set `consumer_id` on context
- 401 with `WWW-Authenticate: Bearer realm="geo-api"` header
- Use `crypto.timingSafeEqual` for token comparison (RESEARCH.md security threat table)

---

### `packages/api/src/routes/audit-post.ts` (route/controller, request-response)

**Analog:** `_templates/bun-hono-app/src/routes/example.ts` (lines 1-45)

**createRoute pattern** (lines 16-36):
```typescript
// _templates/bun-hono-app/src/routes/example.ts lines 16-36
const getItem = createRoute({
  method: 'get',
  path: '/items/{id}',
  tags: ['items'],
  summary: 'Fetch one item',
  request: { params: ItemParams },
  responses: {
    200: { content: { 'application/json': { schema: Item } }, description: '...' },
    404: { content: { 'application/json': { schema: z.object({ error: z.literal('not_found') }) } }, description: '...' },
  },
});

export const exampleRoute = new OpenAPIHono().openapi(getItem, (c) => {
  const { id } = c.req.valid('param');
  return c.json({ ... }, 200);
});
```

**Dedup logic** — application-layer status filter (D-13):
```typescript
const recent = await deps.dal.findRecentByUrlHash(urlHash, DEDUP_TTL_MS);
if (recent && recent.status !== 'failed') {
  return c.json({ job_id: recent.id }, 200);
}
// else: proceed with SSRF check + insertJob
```

**SSRF check at submit** — use `resolveAndValidate` from `@geo/fetch` (exported after D-12):
```typescript
// After D-12 adds validateUrlHost export:
import { validateUrlHost } from '@geo/fetch';
const ssrf = await validateUrlHost(callbackUrl);
if (!ssrf.ok) return c.json({ error: 'ssrf_blocked', message: '...' }, 400);
```

---

### `packages/api/src/routes/audit-get.ts` (route/controller, request-response)

**Analog:** `_templates/bun-hono-app/src/routes/example.ts` (full file)

Same `createRoute` pattern. Key handler logic:
```typescript
const job = await deps.dal.getJob(id);
// 404 if not found OR wrong consumer (D-05 ownership check)
if (!job || job.consumerId !== c.get('consumer_id')) {
  return c.json({ error: 'not_found', message: 'Job not found' }, 404);
}
// score+findings only when done
const body = job.status === 'done'
  ? { status: job.status, score: job.score, findings: job.findings }
  : { status: job.status };
return c.json(body, 200);
```

---

### `packages/api/src/routes/audits-list.ts` (route/controller, CRUD)

**Analog:** `_templates/bun-hono-app/src/routes/example.ts` + `packages/db/src/dal.ts` `listJobs` (lines 319-327)

Query param schema (zod):
```typescript
const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
```

Handler:
```typescript
const { page, limit } = c.req.valid('query');
const offset = (page - 1) * limit;
const jobs = await deps.dal.listJobs({ consumerId: c.get('consumer_id'), limit, offset });
return c.json({ jobs, page, limit }, 200);
```

Note: after D-11, `listJobs` accepts `{ consumerId, limit, offset }` — see DAL extension pattern below.

---

### `packages/api/src/routes/healthz.ts` (route/controller, request-response)

**Analog:** `_templates/bun-hono-app/src/index.ts` healthRoute (lines 9-30)

```typescript
// _templates/bun-hono-app/src/index.ts lines 9-30
const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['system'],
  responses: {
    200: { content: { 'application/json': { schema: z.object({ ok: z.literal(true), uptime_s: z.number() }) } }, description: 'Service is alive' },
  },
});
app.openapi(healthRoute, (c) => c.json({ ok: true as const, uptime_s: Math.floor(process.uptime()) }));
```

**Deep DB check adaptation** (RESEARCH.md healthz pattern):
```typescript
app.openapi(healthzRoute, async (c) => {
  try {
    await deps.dal.selectOne(); // or getSql().unsafe('SELECT 1')
    return c.json({ status: 'ok' as const, db: 'ok' as const }, 200);
  } catch {
    return c.json({ status: 'error' as const, db: 'error' as const }, 503);
  }
});
```

---

### `packages/api/src/__tests__/pglite-helper.ts` (test utility)

**Analog:** `packages/db/src/__tests__/harness.ts` (full file, lines 1-118) — copy and re-export with migration path pointing to `packages/db/migrations/`.

Key imports to replicate:
```typescript
// packages/db/src/__tests__/harness.ts lines 21-22
import { PGlite } from "@electric-sql/pglite";
import { describe } from "vitest";
```

Key export to copy:
```typescript
// packages/db/src/__tests__/harness.ts lines 48-68 — makePgliteDb factory
export async function makePgliteDb(): Promise<DbHandle> {
  const db = new PGlite();
  // exec, query, close adapters
  return { exec, query, close };
}
```

Also copy `hasRealDb`, `assertTestDatabaseUrl`, `describeIfRealDb` — same pattern, same safety guards.

The API test helper additionally needs to run migrations and create a DAL:
```typescript
// pglite-helper.ts additions
import { runMigrations } from '@geo/db/migrate'; // or direct path
import { createAuditDal } from '@geo/db';

export async function makeTestDal() {
  const db = await makePgliteDb();
  await db.exec(/* read migration files */);
  const executor = makePgliteExecutor(db); // see dal.ts test pattern
  return { dal: createAuditDal(executor), db };
}
```

**Migration path:** `join(__dirname, '../../../../db/migrations')` — same pattern as `packages/db/src/__tests__/schema.test.ts` lines 17-18:
```typescript
// packages/db/src/__tests__/schema.test.ts lines 17-18
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
```

---

### `packages/api/src/__tests__/*.test.ts` (tests)

**Analog:** `packages/db/src/__tests__/harness.test.ts` + `packages/db/src/__tests__/schema.test.ts`

**Test file structure** (harness.test.ts lines 1-10):
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { makePgliteDb } from "./harness.js";

describe("...", () => {
  let db: DbHandle | undefined;
  afterEach(async () => { if (db) { await db.close(); db = undefined; } });
  it("...", async () => { ... });
});
```

**app.request() test pattern** (RESEARCH.md Pattern 5):
```typescript
// No Bun.serve — use Hono's built-in app.request()
const res = await app.request('/audit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-test' },
  body: JSON.stringify({ url: 'https://example.com' }),
});
expect(res.status).toBe(200);
```

**Injectable mock resolver** (for SSRF tests) — mirror `packages/fetch/src/safe-fetcher.ts` `SafeFetcherOptions.resolver` (line 47):
```typescript
// packages/fetch/src/safe-fetcher.ts line 47
resolver?: Resolver;

// Test usage:
const mockResolver = async (hostname: string) => ['127.0.0.1']; // loopback → SSRF_BLOCKED
const fetcher = createSafeFetcher({ resolver: mockResolver });
```

---

### `packages/db/migrations/0002_add_consumer_id.sql` (migration)

**Analog:** `packages/db/migrations/0001_create_audits.sql` (full file)

**Style to mirror** (lines 1-57):
- Header comment block naming migration number, decision, and intent
- `IF NOT EXISTS` guards where applicable
- `CREATE INDEX IF NOT EXISTS` pattern (lines 44-57)

```sql
-- Migration 0002: Add consumer_id to audits
-- Implements D-11: consumer scoping for API-02/03/05.
-- Additive / non-breaking: nullable column; existing rows get NULL consumer_id.

ALTER TABLE audits ADD COLUMN IF NOT EXISTS consumer_id text;

-- Index: history lookups by consumer (API-03 listJobs filter)
CREATE INDEX IF NOT EXISTS idx_audits_consumer_id
  ON audits (consumer_id, created_at DESC)
  WHERE consumer_id IS NOT NULL;
```

---

### `packages/db/src/dal.ts` extensions (service, CRUD)

**Analog:** self — existing `insertJob` (lines 164-173), `listJobs` (lines 319-327), `getJob` (lines 307-313)

**`insertJob` SQL extension** (mirror lines 165-169):
```typescript
// packages/db/src/dal.ts lines 165-169 — current
const rows = await executor.query<AuditRow>(
  `INSERT INTO audits (url, normalized_url, url_hash, callback_url)
   VALUES ($1, $2, $3, $4)
   RETURNING *`,
  [input.url, input.normalizedUrl, input.urlHash, input.callbackUrl ?? null],
);

// After D-11 — add consumer_id:
const rows = await executor.query<AuditRow>(
  `INSERT INTO audits (url, normalized_url, url_hash, callback_url, consumer_id)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING *`,
  [input.url, input.normalizedUrl, input.urlHash, input.callbackUrl ?? null, input.consumerId ?? null],
);
```

**`listJobs` extension** (mirror lines 320-327):
```typescript
// packages/db/src/dal.ts lines 320-327 — current (no consumer filter)
const rows = await executor.query<AuditRow>(
  `SELECT * FROM audits ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
  [pagination.limit, pagination.offset],
);

// After D-11 — add optional consumer_id filter:
const rows = await executor.query<AuditRow>(
  `SELECT * FROM audits
    WHERE ($3::text IS NULL OR consumer_id = $3)
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2`,
  [pagination.limit, pagination.offset, pagination.consumerId ?? null],
);
```

---

### `packages/db/src/types.ts` extensions (model)

**Analog:** self — `InsertJobInput` (lines 64-69), `PaginationInput` (lines 71-74), `AuditJob` (lines 41-58)

```typescript
// packages/db/src/types.ts lines 64-69 — extend InsertJobInput
export interface InsertJobInput {
  url: string;
  normalizedUrl: string;
  urlHash: string;
  callbackUrl?: string;
  consumerId?: string;   // ADD: nullable; existing rows get null
}

// packages/db/src/types.ts lines 71-74 — extend PaginationInput
export interface PaginationInput {
  limit: number;
  offset: number;
  consumerId?: string;   // ADD: optional filter for consumer-scoped listJobs
}

// packages/db/src/types.ts lines 41-58 — add consumerId to AuditJob
export interface AuditJob {
  // ... existing fields ...
  consumerId: string | null;   // ADD
}
```

---

### `packages/fetch/src/safe-requester.ts` (utility, request-response)

**Analog:** `packages/fetch/src/safe-fetcher.ts` (full file) — same structure, same `validateUrl` internal function reuse

**Key pattern to replicate** from `safe-fetcher.ts`:
- Import and reuse `resolveAndValidate` + `DnsValidationError` from `./dns-resolve.js` (lines 24-27)
- Import `isBlockedIP` from `./ip-validator.js` via `validateUrl` (line 136)
- Import `FetchErrorCode`, `buildErrorResult` from `./errors.js` (lines 25-26)
- Use `undici request()` with pinned IP + `servername` for TLS (lines 221-229)
- Never throw — return `FetchResult` shape with `error` field (line 374)

**New exports** (additive to `packages/fetch/src/index.ts`):
```typescript
// Add to packages/fetch/src/index.ts barrel:
export { createSafeRequester, validateUrlHost } from "./safe-requester.js";
export type { SafeRequesterOptions } from "./safe-requester.js";
```

`validateUrlHost(url)` — hostname-only validation without making a network request. Calls `resolveAndValidate` (from `./dns-resolve.js` lines 77-109) and returns `{ ok: boolean; code?: FetchErrorCode }`. The API uses this at submit time (D-08).

`createSafeRequester(options)` — same factory pattern as `createSafeFetcher` but accepts `method` + `body`. Uses same `validateUrl` internal + pinned undici POST. The worker `webhook.ts` uses this at fire time.

---

### `packages/worker/src/webhook.ts` (service, event-driven)

**Analog:** `packages/worker/src/pipeline.ts` (lines 28-46) for deps pattern; `packages/fetch/src/safe-fetcher.ts` for SSRF reuse

**Deps pattern** (pipeline.ts lines 28-46):
```typescript
// packages/worker/src/pipeline.ts lines 28-46
export interface PipelineDeps {
  dal: AuditDal;
  scorer: { score(...): Promise<...> };
  fetcher: Fetcher;
  // ...
}
```

Mirror for webhook:
```typescript
// packages/worker/src/webhook.ts
import { createSafeRequester } from '@geo/fetch';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;

export async function deliverWebhook(
  callbackUrl: string,
  payload: { job_id: string; status: string; score: number | null; findings: unknown },
): Promise<void> {
  const requester = createSafeRequester({ timeoutMs: DEFAULT_TIMEOUT_MS });
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await requester(callbackUrl, { method: 'POST', body: JSON.stringify(payload) });
    if (!result.error) return;
    // non-fatal: log and continue
    console.warn(`[webhook] delivery attempt ${attempt + 1} failed: ${result.error}`);
  }
}
```

---

### `packages/worker/src/pipeline.ts` extensions (service, event-driven)

**Analog:** self — `completeJob` call site (line 158), three `failJob` call sites (lines ~82, ~134, ~143)

**Insertion pattern** (after line 158):
```typescript
// packages/worker/src/pipeline.ts line 158 — current
const ok = await dal.completeJob(job.id, job.leaseToken!, scored.score, merged);
if (!ok) console.warn(`[pipeline] completeJob lease-loss for job ${job.id}`);

// ADD after line 158:
if (job.callbackUrl && ok) {
  deliverWebhook(job.callbackUrl, { job_id: job.id, status: 'done', score: scored.score, findings: merged })
    .catch(err => console.warn('[pipeline] webhook delivery failed:', err));
}
```

Repeat the non-fatal `.catch` pattern at each of the three `failJob` sites. Consider a `tryDeliverWebhook(job, status)` helper to DRY across 4 sites.

---

## Shared Patterns

### Fail-Fast Env Guard
**Source:** `packages/db/src/client.ts` lines 22-32
**Apply to:** `packages/api/src/middleware/auth.ts` (`GEO_API_KEYS`), `packages/api/src/main.ts`
```typescript
const url = process.env["DATABASE_URL"];
if (!url) {
  throw new Error(
    "@geo/db: DATABASE_URL is required but not set. " +
      "Set DATABASE_URL in your environment (see .env.example). " +
      "Do not include a real connection string in any committed file.",
  );
}
```

### PGlite Test Harness
**Source:** `packages/db/src/__tests__/harness.ts` lines 48-68
**Apply to:** All `packages/api/src/__tests__/*.test.ts` via `pglite-helper.ts`
```typescript
export async function makePgliteDb(): Promise<DbHandle> {
  const db = new PGlite();
  const exec = async (sql: string) => { await db.exec(sql); };
  const query = async <T>(sql: string, params?: unknown[]) => {
    const result = await db.query<T>(sql, params);
    return result.rows;
  };
  const close = async () => { await db.close(); };
  return { exec, query, close };
}
```

### Migration Path Resolution
**Source:** `packages/db/src/__tests__/schema.test.ts` lines 15-18
**Apply to:** `packages/api/src/__tests__/pglite-helper.ts`
```typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
```

### OpenAPIHono Route Registration
**Source:** `_templates/bun-hono-app/src/routes/example.ts` lines 38-45
**Apply to:** ALL route files in `packages/api/src/routes/`
```typescript
// NEVER app.get/post — always app.openapi(createRoute(...), handler)
export const exampleRoute = new OpenAPIHono().openapi(getItem, (c) => {
  const { id } = c.req.valid('param');
  return c.json({ ... }, 200);
});
```

### Error Envelope
**Source:** `_templates/bun-hono-app/src/routes/example.ts` lines 28-35 (404 schema shape)
**Apply to:** All routes — consistent `{ error: string, message: string }` for 400/401/404/503/500
```typescript
z.object({ error: z.literal('not_found') })
// Generalized:
z.object({ error: z.string(), message: z.string() })
```

### Parameterised SQL (no injection)
**Source:** `packages/db/src/dal.ts` lines 1-14 (header comment) + all query calls using `$N` placeholders
**Apply to:** Any SQL added in migration DAL extensions
```typescript
// T-03-INJ: never string-concatenate user values into SQL
// Always pass user values as params array: executor.query(sql, [val1, val2])
```

### Injectable Deps for Testability
**Source:** `packages/worker/src/pipeline.ts` lines 28-46 (`PipelineDeps` interface)
**Apply to:** `packages/api/src/app.ts` `AppDeps`, `packages/worker/src/webhook.ts`
```typescript
export interface PipelineDeps {
  dal: AuditDal;
  fetcher: Fetcher;
  // ... injectable for tests
}
```

### SSRF Resolve-Then-Pin
**Source:** `packages/fetch/src/safe-fetcher.ts` lines 100-166 (`validateUrl` internal function) + `packages/fetch/src/dns-resolve.ts` lines 77-109 (`resolveAndValidate`)
**Apply to:** `packages/fetch/src/safe-requester.ts` (reuse same `validateUrl` function) and `packages/api/src/routes/audit-post.ts` (submit-time via new `validateUrlHost` export)

Key: `resolveAndValidate` (dns-resolve.ts line 77) validates ALL A+AAAA records — any blocked IP poisons the set. Do not re-implement.

---

## No Analog Found

None — all files have strong analogs in the codebase or template.

---

## Metadata

**Analog search scope:** `packages/db/`, `packages/fetch/`, `packages/worker/`, `_templates/bun-hono-app/`
**Files scanned:** 14 source files
**Pattern extraction date:** 2026-06-02

---

## PATTERN MAPPING COMPLETE

**Phase:** 5 — Bun+Hono API Layer
**Files classified:** 23 (including extensions to existing files)
**Analogs found:** 23 / 23

### Coverage
- Files with exact analog: 12
- Files with role-match analog: 11
- Files with no analog: 0

### Key Patterns Identified
- All routes use `app.openapi(createRoute(...), handler)` — never `app.get/post`; template comment enforces this
- Package scaffold (package.json / tsup.config.ts / vitest.config.ts) mirrors `@geo/db` verbatim except name + deps; zod pinned at `^3.25.51` (NOT template's v4)
- PGlite harness from `packages/db/src/__tests__/harness.ts` is the test foundation — copy + re-export with cross-package migration path
- Fail-fast env guard from `packages/db/src/client.ts` applies to `GEO_API_KEYS` in auth middleware
- `createSafeRequester` in `packages/fetch/src/safe-requester.ts` reuses `validateUrl` + `resolveAndValidate` internals from `safe-fetcher.ts` — no SSRF logic duplication
- Factory pattern `createApp({dal, fetcher})` from RESEARCH.md Pattern 3; production wiring in `main.ts`, PGlite injection in tests

### File Created
`C:\Users\artic\GitHub\geo-seo-claude\.planning\phases\05-bun-hono-api-layer\05-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. Planner can reference analog patterns in PLAN.md files.
