# Phase 4: Worker Pipeline - Pattern Map

**Mapped:** 2026-06-02
**Files analyzed:** 12
**Analogs found:** 12 / 12

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/worker/package.json` | config | — | `packages/db/package.json` | exact |
| `packages/worker/tsup.config.ts` | config | — | `packages/db/tsup.config.ts` | exact (multi-entry) |
| `packages/worker/vitest.config.ts` | config | — | `packages/db/vitest.config.ts` | exact |
| `packages/worker/src/index.ts` | barrel | — | `packages/db/src/index.ts` | exact |
| `packages/worker/src/main.ts` | utility/entry | request-response | `packages/db/src/client.ts` (env fail-fast) | role-match |
| `packages/worker/src/env.ts` | utility | — | `packages/db/src/client.ts` (assertDatabaseUrl pattern) | exact pattern |
| `packages/worker/src/worker.ts` | service | event-driven | `packages/db/src/dal.ts` (poll-loop consumer) | role-match |
| `packages/worker/src/pipeline.ts` | service | request-response | `packages/db/src/dal.ts` (single-job transaction) | role-match |
| `packages/worker/src/scorer.ts` | service | request-response | `packages/fetch/src/safe-fetcher.ts` (injected-dep + error classification) | role-match |
| `packages/worker/src/__tests__/scorer.test.ts` | test | — | `packages/fetch/src/__tests__/safe-fetcher.test.ts` | exact |
| `packages/worker/src/__tests__/pipeline.test.ts` | test | — | `packages/db/src/__tests__/queue.test.ts` + `packages/db/src/__tests__/lifecycle.test.ts` | exact |
| `packages/worker/src/__tests__/worker.test.ts` | test | — | `packages/db/src/__tests__/concurrency.test.ts` | role-match |

---

## Pattern Assignments

### `packages/worker/package.json` (config)

**Analog:** `packages/db/package.json`

**Full shape** (`packages/db/package.json` lines 1–38):
```json
{
  "name": "@geo/worker",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "bin": {
    "geo-worker": "./dist/main.js"
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest"
  },
  "dependencies": {
    "@geo/core": "workspace:*",
    "@geo/fetch": "workspace:*",
    "@geo/db": "workspace:*",
    "@anthropic-ai/sdk": "0.100.1",
    "zod": "<workspace version>"
  },
  "devDependencies": {
    "@electric-sql/pglite": "0.5.1",
    "@types/node": "25.9.1",
    "tsup": "8.5.1",
    "typescript": "6.0.3",
    "vitest": "4.1.8"
  }
}
```

**Key deltas from db analog:**
- Name → `@geo/worker`
- Add `"bin"` entry pointing to `./dist/main.js` for `src/main.ts` Phase 6 entrypoint
- `dependencies`: replace `postgres` with `@anthropic-ai/sdk` + `zod` + all three workspace peers
- No `migrations` in `"files"`; no `migrate`/`migrate:status` scripts

---

### `packages/worker/tsup.config.ts` (config)

**Analog:** `packages/db/tsup.config.ts` lines 1–10 — identical except add `src/main.ts` to entries:

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts"],  // main.ts = Phase 6 bin entry
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
});
```

---

### `packages/worker/vitest.config.ts` (config)

**Analog:** `packages/db/vitest.config.ts` lines 1–9 — copy verbatim:

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

### `packages/worker/src/index.ts` (barrel)

**Analog:** `packages/db/src/index.ts` lines 1–27

**Pattern** — comment header + grouped re-exports by concern:
```typescript
// @geo/worker — public surface area

export { runWorker } from "./worker.js";
export type { WorkerOptions } from "./worker.js";

export { ScoringError } from "./scorer.js";
export type { AnthropicMessagesClient, GeoScoreOutput } from "./scorer.js";
```

The db barrel (`packages/db/src/index.ts`) uses:
- Section comment per logical group
- `.js` extensions on all local imports (ESM + tsup requirement)
- `export type {}` for pure types, plain `export {}` for values

---

### `packages/worker/src/env.ts` (utility — fail-fast env guard)

**Analog:** `packages/db/src/client.ts` lines 1–51

**Pattern** — the `getSql()` / `assertDatabaseUrl` fail-fast guard:
```typescript
// packages/db/src/client.ts lines 21-34 (exact pattern to mirror)
export function getSql(): Sql {
  if (_sql !== undefined) {
    return _sql;
  }

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

**Worker analog** (`src/env.ts`) — same shape, different vars:
```typescript
export function assertEnv(): void {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "@geo/worker: ANTHROPIC_API_KEY is required but not set. " +
        "Set ANTHROPIC_API_KEY in your environment (Coolify env in Phase 6). " +
        "Never commit a real API key.",
    );
  }
  if (!process.env["DATABASE_URL"]) {
    throw new Error(
      "@geo/worker: DATABASE_URL is required but not set.",
    );
  }
}
```

Called at the TOP of `src/main.ts` before any other initialization (same as `getSql()` being called before any DB operation).

---

### `packages/worker/src/main.ts` (bin entry)

**Analog:** `packages/db/src/client.ts` (env-guard pattern) + standard Bun entry

**Pattern** — thin entry, call assertEnv(), build dependencies, call runWorker():
```typescript
// src/main.ts — Phase 6 runs this as: bun src/main.ts
import { assertEnv } from "./env.js";
import { runWorker } from "./worker.js";

assertEnv();  // fail-fast before any async work

await runWorker({
  concurrency: parseInt(process.env["WORKER_CONCURRENCY"] ?? "3", 10),
  pollIntervalMs: parseInt(process.env["POLL_INTERVAL_MS"] ?? "1000", 10),
  leaseTtlSecs: parseInt(process.env["LEASE_TTL_SECONDS"] ?? "120", 10),
  reclaimIntervalMs: parseInt(process.env["RECLAIM_INTERVAL_MS"] ?? "60000", 10),
  maxAttempts: parseInt(process.env["MAX_ATTEMPTS"] ?? "3", 10),
  scoringTimeoutMs: parseInt(process.env["SCORING_TIMEOUT_MS"] ?? "60000", 10),
  shutdownGraceMs: parseInt(process.env["SHUTDOWN_GRACE_MS"] ?? "30000", 10),
  scoringModel: process.env["SCORING_MODEL"] ?? "claude-sonnet-4-6",
});
```

---

### `packages/worker/src/worker.ts` (service — poll loop)

**Analog:** `packages/db/src/dal.ts` lines 129–322 (factory pattern with injected executor)

**Factory pattern** (`dal.ts` lines 129–130):
```typescript
export function createAuditDal(executor: SqlExecutor): AuditDal {
  // inner async functions capture executor
```

**Worker mirrors this** as `runWorker(opts: WorkerOptions)` — accepts deps by parameter (DAL, scorer, fetcher factory), not global imports. This is the same injection seam the DAL uses for `SqlExecutor`.

**In-flight counter + poll loop** (from RESEARCH Pattern 3):
```typescript
let inFlight = 0;
// ...
if (inFlight < MAX) {
  const job = await dal.claimNextJob(LEASE_TTL_SECONDS);
  if (job) {
    inFlight++;
    runAudit(job).finally(() => inFlight--);  // .finally() is mandatory
  } else {
    await sleep(POLL_INTERVAL_MS);
  }
}
```

**Graceful shutdown** (`process.on` from RESEARCH Pattern 5):
```typescript
let shuttingDown = false;
process.on("SIGTERM", () => { shuttingDown = true; });
process.on("SIGINT",  () => { shuttingDown = true; });
```

**Shutdown drain with hard timeout** — `Promise.race` between drain loop and `SHUTDOWN_GRACE_MS` timer (RESEARCH Pitfall 6).

---

### `packages/worker/src/pipeline.ts` (service — single job pipeline)

**Analog:** `packages/db/src/dal.ts` (single-transaction success/fail pattern at lines 215–255)

**completeJob/failJob** dual-path pattern (`dal.ts` lines 216–255):
```typescript
// completeJob — only called on success path
async completeJob(...): Promise<boolean> {
  const rows = await executor.query<{ id: string }>(
    `UPDATE audits SET status = 'done', ... WHERE id = $1 AND lease_token = $2::uuid ...`,
    [id, leaseToken, score, JSON.stringify(findings)],
  );
  return rows.length > 0;
},
// failJob — called on any error path
async failJob(...): Promise<boolean> { ... }
```

**Pipeline mirrors this dual-path** — only the success path calls `dal.completeJob`, all catch branches call `dal.failJob`. No partial writes.

**Heartbeat pattern** (RESEARCH Pattern 4):
```typescript
async function runAudit(job: AuditJob, dal: AuditDal): Promise<void> {
  const ac = new AbortController();
  const heartbeat = setInterval(async () => {
    const ok = await dal.renewLease(job.id, job.leaseToken!, LEASE_TTL_SECONDS);
    if (!ok) { ac.abort(); }
  }, (LEASE_TTL_SECONDS * 1000) / 2);
  try {
    await pipeline(job, ac.signal, dal);
  } finally {
    clearInterval(heartbeat);  // MUST be in finally (RESEARCH Pitfall 4)
  }
}
```

---

### `packages/worker/src/scorer.ts` (service — Anthropic SDK call)

**Analog:** `packages/fetch/src/safe-fetcher.ts` (constructor-injected dep + error classification)

The safe-fetcher (`packages/fetch/src/__tests__/safe-fetcher.test.ts` lines 14–19) is tested via injected dependencies rather than module mocks — the same pattern the scorer uses via `AnthropicMessagesClient`.

**Injected interface pattern** (RESEARCH Pattern 6):
```typescript
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
  };
}

export function createScorer(client: AnthropicMessagesClient) { ... }
```

**Forced tool-use + extraction** (RESEARCH Pattern 1):
```typescript
const response = await client.messages.create({
  model: scoringModel,
  max_tokens: 1024,
  system: [
    {
      type: "text",
      text: GEO_SCORING_RUBRIC,       // static — cache this
      cache_control: { type: "ephemeral" },
    },
  ],
  tools: [{ name: "record_geo_score", ... }],
  tool_choice: { type: "tool", name: "record_geo_score" },
  messages: [{ role: "user", content: JSON.stringify(deterministicFindings) }],
}, { signal: abortController.signal });

const toolUseBlock = response.content.find(b => b.type === "tool_use");
if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
  throw new ScoringError("SCORING_MALFORMED_OUTPUT", false);
}
const parsed = GeoScoreSchema.safeParse(toolUseBlock.input);
```

**Error classification** (RESEARCH Code Examples — `classifyScoringError`):
```typescript
import Anthropic from "@anthropic-ai/sdk";

function classifyScoringError(err: unknown): ScoringError {
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new ScoringError("SCORING_TIMEOUT", true);
  if (err instanceof Anthropic.APIUserAbortError)
    return new ScoringError("SCORING_TIMEOUT", true);
  if (err instanceof Anthropic.APIConnectionError)
    return new ScoringError("SCORING_API_ERROR", true);
  if (err instanceof Anthropic.RateLimitError)
    return new ScoringError("SCORING_RATE_LIMITED", true);
  if (err instanceof Anthropic.InternalServerError)
    return new ScoringError("SCORING_API_ERROR", true);
  if (err instanceof Anthropic.APIError)
    return new ScoringError("SCORING_API_ERROR", (err as Anthropic.APIError).status >= 500);
  return new ScoringError("SCORING_API_ERROR", false);
}
```

**ScoringError class** (RESEARCH Code Examples):
```typescript
export class ScoringError extends Error {
  constructor(
    public readonly code:
      | "SCORING_TIMEOUT"
      | "SCORING_RATE_LIMITED"
      | "SCORING_API_ERROR"
      | "SCORING_MALFORMED_OUTPUT",
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ScoringError";
  }
}
```

**AbortController per-request** (RESEARCH Pattern 2 — with `maxRetries: 0` mandatory):
```typescript
// CRITICAL: maxRetries: 0 — own retries via lease/attempts, not SDK auto-retry
const client = new Anthropic({ apiKey, maxRetries: 0 });

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), SCORING_TIMEOUT_MS);
try {
  const response = await client.messages.create({ ... }, { signal: ac.signal });
  return response;
} finally {
  clearTimeout(timer);
}
```

---

### `packages/worker/src/__tests__/scorer.test.ts` (test — unit, mock Anthropic)

**Analog:** `packages/fetch/src/__tests__/safe-fetcher.test.ts` lines 1–45 (imports + helper structure)

**Test file structure** (mirror `safe-fetcher.test.ts`):
```typescript
import { describe, it, expect, vi } from "vitest";
import { createScorer, ScoringError } from "../scorer.js";
import type { AnthropicMessagesClient } from "../scorer.js";

// Construct fake client — NOT vi.mock('@anthropic-ai/sdk') (hoisting fragile)
function buildMockClient(overrides?: Partial<...>): AnthropicMessagesClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(buildMockResponse()),
    },
  };
}
```

**Error class instantiation in tests** — import from `@anthropic-ai/sdk` to build real error instances for mock throws:
```typescript
import Anthropic from "@anthropic-ai/sdk";
// Throw real SDK error subclasses so instanceof checks in scorer work:
mockClient.messages.create = vi.fn().mockRejectedValue(
  new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers()),
);
```

---

### `packages/worker/src/__tests__/pipeline.test.ts` (test — integration, PGlite + loopback)

**Analog:** `packages/db/src/__tests__/lifecycle.test.ts` lines 1–50 and `packages/db/src/__tests__/queue.test.ts` lines 1–56

**PGlite harness import** (from `lifecycle.test.ts` lines 9–18):
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { makePgliteDb } from "@geo/db/src/__tests__/harness.js";   // reuse exact helper
import { runMigrations } from "@geo/db";
import { createAuditDal } from "@geo/db";
import { makePgliteExecutor } from "@geo/db/src/__tests__/pglite-executor.js";
import type { DbHandle } from "@geo/db/src/__tests__/harness.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../../db/migrations");
```

**Loopback server import** (from `packages/fetch/test/helpers/test-server.ts`):
```typescript
import { createTestServer } from "@geo/fetch/test/helpers/test-server.js";
```

**beforeEach/afterEach pattern** (`lifecycle.test.ts` lines 19–29 — exact shape to mirror):
```typescript
let db: DbHandle;

beforeEach(async () => {
  db = await makePgliteDb();
  await runMigrations(db, MIGRATIONS_DIR);
});

afterEach(async () => {
  await db.close();
});
```

---

### `packages/worker/src/__tests__/worker.test.ts` (test — unit, fake timers + mock DAL)

**Analog:** `packages/db/src/__tests__/concurrency.test.ts` (PGlite + structural verification)

**Fake timers pattern** (Vitest standard):
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// Advance intervals deterministically:
await vi.advanceTimersByTimeAsync(RECLAIM_INTERVAL_MS);
```

**Mock DAL for shutdown/concurrency tests** — build a fake `AuditDal` object (same injection seam as `makePgliteExecutor` → `createAuditDal`):
```typescript
// Mirror the AuditDal interface from packages/db/src/dal.ts lines 117–127
const mockDal: AuditDal = {
  claimNextJob: vi.fn().mockResolvedValue(null),
  completeJob: vi.fn().mockResolvedValue(true),
  failJob: vi.fn().mockResolvedValue(true),
  renewLease: vi.fn().mockResolvedValue(true),
  reclaimExpired: vi.fn().mockResolvedValue(0),
  insertJob: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
  findRecentByUrlHash: vi.fn(),
};
```

---

## Shared Patterns

### Fail-Fast Env Guard
**Source:** `packages/db/src/client.ts` lines 21–34
**Apply to:** `src/env.ts`, `src/main.ts`
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
Mirror message format: `@geo/worker: <VAR> is required but not set. <where to set it>. <never commit rule>.`

### ESM Import Extensions
**Source:** `packages/db/src/index.ts` lines 4–26 (all local imports use `.js` extension)
**Apply to:** All `src/*.ts` files
All local imports must end in `.js` even though source files are `.ts`. tsup resolves them correctly; Node ESM requires the extension.

### Constructor-Injected Dependency Seam
**Source:** `packages/db/src/dal.ts` lines 129–130 (`createAuditDal(executor: SqlExecutor)`)
**Apply to:** `src/worker.ts`, `src/pipeline.ts`, `src/scorer.ts`
All stateful dependencies (DAL, Anthropic client, fetcher factory) are injected as parameters — never imported as module-level singletons in the implementation files that tests exercise. Tests swap in fakes without `vi.mock()`.

### `.finally()` for Counter/Resource Cleanup
**Source:** `packages/db/src/dal.ts` line 390 (rollback in transaction); RESEARCH Pitfalls 4 + 5
**Apply to:** `src/worker.ts` (inFlight counter), `src/pipeline.ts` (heartbeat interval)
- `runAudit(job).finally(() => inFlight--)` — counter MUST decrement on any outcome
- `clearInterval(heartbeat)` MUST be in `finally` — not in try or catch blocks

### PGlite Test Harness
**Source:** `packages/db/src/__tests__/harness.ts` (`makePgliteDb`), `packages/db/src/__tests__/pglite-executor.ts` (`makePgliteExecutor`)
**Apply to:** `src/__tests__/pipeline.test.ts`, `src/__tests__/worker.test.ts`
Import helpers directly from `@geo/db`'s test utilities. Never replicate harness logic.

### Loopback HTTP Server
**Source:** `packages/fetch/test/helpers/test-server.ts` (`createTestServer`)
**Apply to:** `src/__tests__/pipeline.test.ts`
Import `createTestServer` from `@geo/fetch` test helpers for real `@geo/core` deterministic checks without live network.

---

## No Analog Found

All files have analogs. No entries.

---

## Metadata

**Analog search scope:** `packages/db/`, `packages/fetch/`, `packages/core/`
**Files scanned:** `packages/db/package.json`, `packages/db/tsup.config.ts`, `packages/db/vitest.config.ts`, `packages/db/src/index.ts`, `packages/db/src/client.ts`, `packages/db/src/dal.ts`, `packages/db/src/__tests__/harness.test.ts`, `packages/db/src/__tests__/lifecycle.test.ts`, `packages/db/src/__tests__/queue.test.ts`, `packages/db/src/__tests__/pglite-executor.ts`, `packages/fetch/package.json`, `packages/fetch/src/index.ts`, `packages/fetch/src/errors.ts`, `packages/fetch/src/__tests__/safe-fetcher.test.ts`, `packages/fetch/test/helpers/test-server.ts`, `packages/core/src/index.ts`
**Pattern extraction date:** 2026-06-02
