<!-- refreshed: 2026-07-24 -->
# Architecture

**Analysis Date:** 2026-07-24

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│  Consumers                                                   │
├──────────────────┬──────────────────┬───────────────────────┤
│  Claude Code     │  HTTP clients    │  Scheduled re-audit   │
│  skill/agents    │  (Bearer token)  │  (Coolify cron)       │
│  `geo/SKILL.md`  │                  │  `packages/cron`      │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │  (Python scripts)│  POST /audit        │  POST /audit
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│  @geo/api — Bun.serve + OpenAPIHono                          │
│  `packages/api/src/app.ts`, `routes/`, `middleware/auth.ts`  │
│  Enqueue-only. Never scores inline.                          │
└─────────────────────────┬───────────────────────────────────┘
                          │ audits table = job queue
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  @geo/db — DAL over Postgres (SKIP LOCKED lease queue)        │
│  `packages/db/src/dal.ts`, `packages/db/migrations/*.sql`    │
└─────────────────────────┬───────────────────────────────────┘
                          │ claimJob / renewLease / completeJob
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  @geo/worker — poll loop → runAudit pipeline                  │
│  `packages/worker/src/worker.ts` → `pipeline.ts`             │
└──────┬───────────────────────┬──────────────────┬───────────┘
       │ fetch                 │ deterministic    │ score
       ▼                       ▼                  ▼
┌──────────────┐   ┌────────────────────┐  ┌──────────────────────┐
│ @geo/fetch   │   │ @geo/core          │  │ scorer.ts (API)      │
│ SSRF-safe    │   │ pure checks:       │  │  OR                  │
│ fetch +      │   │ robots/rendering/  │  │ cli-scorer.ts        │
│ decompress   │   │ citability/schema/ │  │ (Claude Code CLI,    │
│              │   │ llmstxt            │  │  subscription auth)  │
└──────────────┘   └────────────────────┘  └──────────────────────┘
                          │
                          ▼
              webhook.ts → consumer callback_url (SSRF-safe POST)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| API app factory | Route registration, OpenAPI registry, `/docs` + `/openapi.json` | `packages/api/src/app.ts` |
| Bearer auth | `GEO_API_KEYS` token → `consumer_id` context var | `packages/api/src/middleware/auth.ts` |
| Submit route | Validate `url` + `callback_url` (SSRF), enqueue job | `packages/api/src/routes/audit-post.ts` |
| Poll route | Fetch one audit scoped to consumer | `packages/api/src/routes/audit-get.ts` |
| History route | Paginated list per consumer | `packages/api/src/routes/audits-list.ts` |
| Health | Liveness/readiness probe | `packages/api/src/routes/healthz.ts` |
| DAL | Queue ops (claim/renew/complete/fail/requeue/reclaim) + CRUD | `packages/db/src/dal.ts` |
| Migrations | Advisory-locked idempotent SQL runner | `packages/db/src/migrate.ts`, `packages/db/migrations/` |
| Deterministic checks | robots, rendering, citability, schema, llms.txt | `packages/core/src/*.ts` |
| SSRF-safe fetch | DNS pinning, IP validation, redirect re-validation, size caps | `packages/fetch/src/safe-fetcher.ts` |
| Decompression | gzip/deflate/br chain + byte-counting bomb guard | `packages/fetch/src/decompression.ts` |
| Worker loop | Bounded concurrency, reclaim sweep, SIGTERM drain | `packages/worker/src/worker.ts` |
| Audit pipeline | fetch → core checks → score → completeJob | `packages/worker/src/pipeline.ts` |
| API scorer | One forced-tool-use Anthropic call, `maxRetries:0` | `packages/worker/src/scorer.ts` |
| CLI scorer | Spawns `claude -p ... --output-format stream-json` | `packages/worker/src/cli-scorer.ts` |
| Webhook | Non-fatal SSRF-safe POST to `callback_url` | `packages/worker/src/webhook.ts` |
| Cron | One-shot batch of `POST /audit` per configured URL | `packages/cron/src/cron.ts` |
| Role dispatch | `GEO_ROLE` → api / worker / cron | `scripts/docker-entrypoint.sh` |
| Skill surface | Claude Code skill + subskills + subagents | `geo/SKILL.md`, `skills/`, `agents/` |

## Pattern Overview

**Overall:** Bun/TypeScript monorepo — layered packages behind a Postgres-backed
job queue, plus a parallel Markdown/Python "skill" surface for interactive use.

**Key Characteristics:**
- **Deterministic core, probabilistic edge.** All measurement in `@geo/core` is
  pure and testable; only the final score narrative goes to a model.
- **Enqueue/poll split.** The API never fetches or scores in the request path; it
  writes a row and returns a `job_id`.
- **Dependency injection everywhere.** No module-level singletons except the lazy
  `getDefaultDal()`; every package exports a factory taking its deps.
- **One image, many roles.** A single Docker build serves api/worker/cron via `GEO_ROLE`.

## Layers

**Interface layer (`packages/api`):**
- Purpose: HTTP contract, auth, validation, OpenAPI docs.
- Location: `packages/api/src/`
- Depends on: `@geo/db` (DAL), `@geo/fetch` (URL validation only).
- Used by: external consumers, `packages/cron`.

**Domain layer (`packages/core`):**
- Purpose: pure GEO analysis primitives; zero I/O beyond an injected `Fetcher`.
- Location: `packages/core/src/`
- Depends on: nothing internal.
- Used by: `packages/worker`.

**Transport layer (`packages/fetch`):**
- Purpose: hardened outbound HTTP (SSRF, redirects, size, decompression).
- Location: `packages/fetch/src/`
- Used by: `packages/api` (validation), `packages/worker` (page fetch + webhook).

**Persistence layer (`packages/db`):**
- Purpose: schema, migrations, `AuditDal` queue + CRUD.
- Location: `packages/db/src/`
- Used by: api, worker, cron tests.

**Execution layer (`packages/worker`, `packages/cron`):**
- Purpose: consume the queue; schedule re-audits.

**Skill layer (`geo/`, `skills/`, `agents/`, `scripts/*.py`, `templates/`, `schema/`, `white-label/`):**
- Purpose: interactive Claude Code usage — Markdown SOPs + deterministic Python
  helpers. Independent of the TypeScript service; shares only the methodology.

## Data Flow

### Primary Request Path (async audit)

1. `POST /audit` with `Authorization: Bearer <token>` (`packages/api/src/routes/audit-post.ts`).
2. `bearerAuth` maps token → `consumer_id` (`packages/api/src/middleware/auth.ts`).
3. `url` and optional `callback_url` are SSRF-validated via `validateUrl` /
   `validateUrlHost` (`packages/fetch/src/safe-fetcher.ts`), with an injectable
   `callbackResolver` (`packages/api/src/app.ts`) so tests need no network.
4. DAL inserts a `queued` audit row; the route returns `job_id` immediately.
5. Worker `runWorker` claims the job with `SKIP LOCKED` + a lease
   (`packages/worker/src/worker.ts`, `packages/db/src/dal.ts`).
6. `runAudit` fetches the page, then runs `checkRobots`, `detectRendering`,
   `computeCitabilityScore`, `validateStructuredData`, `validateLlmsTxt` and builds
   a `FindingsShape` (`packages/worker/src/pipeline.ts`).
7. `scorer.score(findings, signal)` returns `{score, findings}`; a heartbeat calls
   `renewLease` every `leaseTtlSecs/2` and aborts the job when it returns false.
8. `completeJob` runs on the success path only; `deliverWebhook`
   (`packages/worker/src/webhook.ts`) posts to `callback_url` and never affects job state.
9. Consumer polls `GET /audit/:id` or receives the webhook.

### Scoring provider selection

1. `resolveScoringProvider()` reads `SCORING_PROVIDER` (`packages/worker/src/env.ts`);
   `assertEnv(provider)` fails fast before any await (`packages/worker/src/main.ts`).
2. `api` → `createScorer(new Anthropic({ maxRetries: 0 }), { model, timeoutMs })`
   (`packages/worker/src/scorer.ts`).
3. `cli` → `createCliScorer()` spawns the `claude` binary with `ANTHROPIC_API_KEY`
   stripped from the child env, forcing subscription auth via
   `CLAUDE_CODE_OAUTH_TOKEN` / ambient login; stdout is scanned in reverse for the
   `{type:"result",subtype:"success"}` line, then zod-validated
   (`packages/worker/src/cli-scorer.ts`).
4. Both expose the same `.score()` seam, so `worker.ts` / `pipeline.ts` are
   provider-agnostic (`opts.scorer ?? createScorer(...)` in `worker.ts`).

### Container role dispatch

1. Image `ENTRYPOINT` is `sh scripts/docker-entrypoint.sh`.
2. The script `case`s on `GEO_ROLE` (default `api`) and `exec`s the matching
   `packages/<role>/dist/main.js`, making Bun PID 1 so it receives SIGTERM directly.
3. Role is env-driven because Coolify's Dockerfile build pack ignores per-resource
   start-command overrides (verified on Coolify 4.1.1; documented in `Dockerfile`).
4. Migrations run out-of-band as `bun packages/db/scripts/migrate.ts`, not through
   the entrypoint.
5. The runtime stage also installs Node.js + a pinned `@anthropic-ai/claude-code`
   so the worker's CLI scoring path has a `claude` binary; api/cron carry it unused.

### Fetch / decompression path

1. `createSafeFetcher(options)` returns `(url) => Promise<FetchResult>`
   (`packages/fetch/src/safe-fetcher.ts`).
2. Hostname resolved via `packages/fetch/src/dns-resolve.ts`; every returned address
   checked by `packages/fetch/src/ip-validator.ts`; each redirect hop re-validated.
3. Body streamed through `buildDecompressChain(contentEncoding, maxBytes)`
   (`packages/fetch/src/decompression.ts`): more than 2 stacked encodings →
   `DECOMPRESSION_BOMB`; unknown encoding → `FETCH_ERROR`.
4. `makeByteCounter` sits after the final decompressor so the cap applies to
   decompressed bytes.
5. `readBodyBounded` enforces the raw ceiling; all failures surface as
   `FetchErrorCode` values from `packages/fetch/src/errors.ts`. Decompressor stream
   errors are contained rather than crashing the process (HEAD `9af25c2`).
6. `packages/fetch/src/safe-requester.ts` is the POST-capable variant used for webhooks.

**State Management:**
- All durable state is the `audits` table; the worker holds only an in-flight
  `Set<Promise<void>>` plus interval handles.

## Key Abstractions

**`Fetcher`:**
- Purpose: the single outbound-HTTP seam consumed by `@geo/core`.
- Examples: `packages/core/src/types.ts`, `packages/fetch/src/safe-fetcher.ts`.
- Pattern: injected function type.

**`AuditDal` / `SqlExecutor`:**
- Purpose: separates queue semantics from the driver, enabling PGlite tests.
- Examples: `packages/db/src/dal.ts` (`createAuditDal`, `makePgExecutor`,
  `getDefaultDal`, `_resetDefaultDalForTests`), `packages/db/src/__tests__/pglite-executor.ts`.

**`Scorer`:**
- Purpose: interchangeable scoring provider.
- Examples: `packages/worker/src/types.ts`, `scorer.ts`, `cli-scorer.ts`.

**`FindingsShape`:**
- Purpose: the deterministic contract handed to the model.
- Examples: `packages/db/src/types.ts`, consumed in `packages/worker/src/pipeline.ts`.

## Entry Points

**API:** `packages/api/src/main.ts` — default-export `Bun.serve` object; the app is
built lazily so importing without `DATABASE_URL` does not throw.

**Worker:** `packages/worker/src/main.ts` — `assertEnv()` first, then `runWorker`.

**Cron:** `packages/cron/src/main.ts` — one-shot batch; exit code from the summary.

**Migrations:** `packages/db/scripts/migrate.ts`.

**Skill:** `geo/SKILL.md` (frontmatter-declared Claude Code skill, dispatching to
`skills/geo-*/` and `agents/*.md`).

## Architectural Constraints

- **Threading:** single-threaded Bun event loop per role; parallelism is bounded by
  `WORKER_CONCURRENCY` (default 3) in-process plus horizontal worker replicas.
- **Global state:** only the lazy singleton in `getDefaultDal()`
  (`packages/db/src/dal.ts`). Nothing else is module-level mutable.
- **Anthropic SDK must be `maxRetries: 0`** — SDK-internal retries mask
  `RateLimitError` as `APIConnectionTimeoutError` and corrupt retry disposition;
  the lease/attempts mechanism owns retries.
- **`ANTHROPIC_API_KEY` must be absent from the CLI-scorer child env**, or the
  `claude` CLI prefers it and bills the API instead of the subscription.
- **Coolify stop grace must be >= `SHUTDOWN_GRACE_MS`** or drains are truncated.
- **Circular imports:** none. Package deps form a DAG: core/fetch → db → api/worker/cron.

## Anti-Patterns

### Scoring inside the HTTP request

**What happens:** calling a scorer or `createSafeFetcher` from a route handler.
**Why it's wrong:** ties request latency to a model call and reintroduces SSRF
surface in the request path; the queue exists precisely to avoid this.
**Do this instead:** enqueue and let `packages/worker/src/pipeline.ts` do the work.

### Calling `completeJob` on a partial result

**What happens:** marking a job complete after a fetch or scoring error.
**Why it's wrong:** persists a bogus score. `runAudit` calls `completeJob` only on
the success path; fetch errors fail the job before any scoring call.
**Do this instead:** throw a `FetchError`/`ScoringError` and let the pipeline route
to `requeueJob` (retryable, attempts < MAX) or `failJob` (terminal).

### Raw `fetch()` for outbound requests

**What happens:** using global `fetch` for a page or a webhook.
**Why it's wrong:** bypasses DNS pinning, IP validation, redirect re-validation,
and the decompression byte cap.
**Do this instead:** `createSafeFetcher` / `createSafeRequester`
(`packages/fetch/src/safe-requester.ts`).

### Module-level dependency construction

**What happens:** building a DAL, Anthropic client, or fetcher at import time.
**Why it's wrong:** breaks the PGlite test harness and makes imports env-dependent.
**Do this instead:** factory + injected deps, as in
`createApp({ dal, fetcher, apiKeys })` (`packages/api/src/app.ts`).

### Adding a role by adding a CMD override

**What happens:** setting a per-resource start command in Coolify.
**Why it's wrong:** the Dockerfile build pack silently ignores it and runs the
default role.
**Do this instead:** add a `case` branch to `scripts/docker-entrypoint.sh` and set
`GEO_ROLE` in the resource env.

## Error Handling

**Strategy:** typed error classes carrying a code and an explicit retry disposition.

**Patterns:**
- `FetchErrorCode` in `packages/fetch/src/errors.ts` — terminal for a job.
- `ScoringError(code, retryable, detail)` in `packages/worker/src/scorer.ts` —
  `SCORING_TIMEOUT` / `SCORING_RATE_LIMITED` / `SCORING_API_ERROR` /
  `SCORING_MALFORMED_OUTPUT`; `retryable` decides requeue vs fail.
- Webhook failures are logged and swallowed — never job-affecting.
- Cron continues past per-URL failures and aggregates a summary
  (`packages/cron/src/cron.ts`).

## Cross-Cutting Concerns

**Logging:** structured `console` lines carrying `url` + `job_id`/`status`; secrets
(`CRON_API_TOKEN`, bearer tokens, OAuth tokens) are never logged.
**Validation:** zod at both edges — request/response schemas via `@hono/zod-openapi`,
model output via `GeoScoreSchema` in `packages/worker/src/scorer.ts`.
**Authentication:** static bearer tokens parsed from `GEO_API_KEYS` into a
token→`consumer_id` map (`packages/api/src/middleware/auth.ts`); every query is
scoped by `consumer_id`.

---

*Architecture analysis: 2026-07-24*
