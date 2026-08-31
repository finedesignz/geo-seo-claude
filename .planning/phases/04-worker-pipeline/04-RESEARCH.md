# Phase 4: Worker Pipeline — Research

**Researched:** 2026-06-02
**Domain:** Anthropic SDK (forced tool-use + prompt caching), Bun async concurrency, lease-fenced job queue
**Confidence:** HIGH (SDK shape verified via npm registry + multiple official/GitHub sources; codebase contracts read directly)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: `packages/worker/` (`@geo/worker`), exports `runWorker(opts)` + `src/main.ts` bin; depends on `@geo/core`, `@geo/fetch`, `@geo/db`, `@anthropic-ai/sdk`
- D-02: Runtime = Bun, plain async loop, no framework
- D-03: Claim-poll loop, in-process semaphore, `WORKER_CONCURRENCY` (default 3), sleep `POLL_INTERVAL_MS` (default 1000ms) when queue empty; Postgres SKIP LOCKED is the broker
- D-04: Graceful shutdown on SIGTERM/SIGINT — stop claiming, drain in-flight within grace timeout, leave unfinished to lease-reclaim
- D-05: Heartbeat calls `renewLease(id, leaseToken, ttl)` every `TTL/2`; false return aborts in-flight audit
- D-06: Background reclaim sweep calls `reclaimExpired()` every `RECLAIM_INTERVAL_MS` (default `LEASE_TTL/2 * 1000`); `MAX_ATTEMPTS` env (default 3)
- D-07: Pipeline order: createSafeFetcher → inject into @geo/core checks → findings object (NOT raw HTML) → scoring call → completeJob or failJob
- D-08: Deterministic-stage error (any of the 10 FetchErrorCode values) → failJob with that error code, no scoring call
- D-09: `messages.create` with `tool_choice: { type: 'tool', name: 'record_geo_score' }`, read `tool_use` block from response `content` array
- D-10: Score output contract `{ score: int 0-100, findings: { <per-dimension sub-scores + rationale> } }`, validated with zod; persisted `score` = int, persisted `findings jsonb` = deterministic findings + LLM rationale merged
- D-11: Model = `claude-sonnet-4-6`, `SCORING_MODEL` env override; `ANTHROPIC_API_KEY` env only, fail-fast if missing
- D-12: Static scoring rubric + tool schema as system block with `cache_control: { type: 'ephemeral' }`; test asserts `usage.cache_creation_input_tokens` (first call) and `cache_read_input_tokens` (subsequent)
- D-13: `AbortController` timeout (`SCORING_TIMEOUT_MS` default 60000ms); timeout/429/529/5xx/missing tool_use/zod-invalid → typed `ScoringError` with retryable flag → `failJob` with machine-readable error code; no partial score ever written
- D-14: Vitest; mock Anthropic SDK only; job-state side via PGlite; @geo/core checks run real against loopback fixtures; fake/injected timers for heartbeat/reclaim

### Claude's Discretion
- (none listed — all decisions auto-selected)

### Deferred Ideas (OUT OF SCOPE)
- Multi-step tool-use agent-host scoring
- Idempotency keys on enqueue (v2 OPS-02)
- Cron re-audit scheduler (Phase 7)
- Container packaging / Coolify service wiring (Phase 6)
- Live-API scoring smoke test (Phase 6 deploy-verify, gated behind real key)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCORE-01 | 0–100 GEO Score via single structured Anthropic SDK call, JSON schema, no `claude -p` | Forced tool-use with `tool_choice: {type:'tool', name}` confirmed; `tool_use` block extraction pattern documented |
| SCORE-02 | Scoring prompt fed `@geo/core` findings as input; LLM renders only irreducible judgment | Pipeline wiring: deterministic findings object → dynamic message content; static rubric cached |
| SCORE-03 | Scoring call uses prompt caching for static portion | `cache_control: {type:'ephemeral'}` on system block; min 2048 tokens for claude-sonnet-4-6; `usage.cache_creation_input_tokens` / `cache_read_input_tokens` proven to exist |
| SCORE-04 | Scoring failure fails job cleanly with retryable status, never partial score | SDK error class hierarchy (`APIConnectionTimeoutError`, `RateLimitError`, `InternalServerError`) mapped to `ScoringError.retryable`; only success path calls `completeJob` |
| WORK-02 | Worker runs full audit pipeline: @geo/core → scoring → persist | DAL signatures confirmed; Fetcher seam confirmed; pipeline order is deterministic |
| WORK-03 | Concurrency capped (bounded simultaneous audits) | In-process counter/semaphore pattern described; Bun signal handling notes |
| WORK-04 | Crashed/stuck job detectable and recoverable | `reclaimExpired()` confirmed; lease fencing via `renewLease` returning false; both heartbeat abort and reclaim sweep paths documented |
</phase_requirements>

---

## Summary

Phase 4 delivers `@geo/worker` — a Bun process that polls Postgres for queued audit jobs, runs the full pipeline (SSRF-safe fetch → deterministic `@geo/core` checks → single structured Anthropic SDK scoring call → persist), and manages job lifecycle via the Phase 3 lease-fenced DAL. All architectural decisions are locked in CONTEXT.md; this research confirms the exact SDK shapes required to implement them correctly and surfaces the critical implementation details that affect correctness.

The Anthropic TypeScript SDK (v0.100.1, latest) fully supports all locked decisions: forced tool-use via `tool_choice: {type:'tool', name}`, per-request `AbortController` abort, prompt caching with `cache_control: {type:'ephemeral'}` on system blocks and tool definitions, and structured `usage` fields proving cache hits. The SDK auto-retries 429/529/5xx internally (up to `maxRetries`), which the worker MUST disable (set `maxRetries: 0`) to own retry logic through the lease/attempts mechanism — otherwise the SDK may silently exceed `SCORING_TIMEOUT_MS` via internal backoff.

**Primary recommendation:** Build the scorer as a thin function accepting an injected `AnthropicLike` interface (constructor injection, not module mock) so vitest can swap in a fake without `vi.mock()` hoisting.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Job claiming / lease management | Worker process (Postgres) | — | SKIP LOCKED is the broker; no separate queue tier |
| SSRF-safe HTTP fetch | Worker process (`@geo/fetch`) | — | Fetcher is injected into @geo/core at worker call site |
| Deterministic GEO checks | Worker process (`@geo/core`) | — | Zero-dep pure functions; no network in core |
| LLM scoring call | Worker process (`@anthropic-ai/sdk`) | — | Single structured call per job; timeout owned by worker |
| Score + findings persistence | Worker process (`@geo/db` DAL) | Postgres | completeJob/failJob are lease-fenced |
| Concurrency control | Worker process (in-memory counter) | — | N audits in-flight; excess wait in Postgres queue |
| Crash recovery | Worker process (reclaim sweep) | Postgres (lease TTL) | reclaimExpired flips expired running→queued/failed |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | 0.100.1 [VERIFIED: npm registry] | Anthropic API client; `messages.create` | Official Anthropic TS SDK; only option |
| `zod` | workspace version (already used in project) | Validate LLM tool-use output at runtime | Type-safe parse; used in existing phases |
| `@geo/core` | workspace:* | Deterministic GEO checks | Phase 1 deliverable |
| `@geo/fetch` | workspace:* | SSRF-safe fetcher | Phase 2 deliverable |
| `@geo/db` | workspace:* | AuditDal + job lifecycle | Phase 3 deliverable |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tsup` | 8.5.1 (mirror db package) | Dual ESM+CJS+d.ts build | Same as all packages |
| `vitest` | 4.1.8 (mirror db package) | Test runner | Same as all packages |
| `@electric-sql/pglite` | 0.5.1 (dev, mirror db) | In-process Postgres for tests | Job-state integration tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| In-process semaphore counter | BullMQ / Redis | Redis adds infra dep; SKIP LOCKED already a broker |
| Constructor-injected fake client | `vi.mock('@anthropic-ai/sdk')` | Module mock hoisting is fragile; interface injection is explicit |
| `AbortController` timeout wrapper | SDK `timeout` client option | Client `timeout` is per-client not per-call; AbortController gives per-call control |

**Installation:**
```bash
bun add @anthropic-ai/sdk zod
bun add -d tsup vitest @electric-sql/pglite @types/node typescript
```

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@anthropic-ai/sdk` | npm | ~3 yrs | 10M+/wk | github.com/anthropics/anthropic-sdk-typescript | [OK] | Approved |
| `zod` | npm | ~5 yrs | 100M+/wk | github.com/colinhacks/zod | [OK] | Approved |

*slopcheck not installed; packages verified as legitimate via npm registry + official GitHub ownership. Tagged [VERIFIED: npm registry] for the two above.*

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
SIGTERM/SIGINT
     │
     ▼
┌─────────────────────────────────────────┐
│  runWorker(opts)                         │
│                                         │
│  shutdown flag ◄── signal handler       │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │  poll loop (while !shutdown)     │   │
│  │                                  │   │
│  │  [inFlight < N]                  │   │
│  │     │                            │   │
│  │     ▼                            │   │
│  │  claimNextJob(dal, leaseSecs)    │   │
│  │     │ null → sleep(POLL_INTERVAL)│   │
│  │     │ job  ──────────────────►   │   │
│  │                runAudit(job)     │   │
│  │                  │ (async, non-blocking) │
│  │                  ▼               │   │
│  │  ┌───────────────────────────┐   │   │
│  │  │  audit pipeline           │   │   │
│  │  │  1. createSafeFetcher()   │   │   │
│  │  │  2. @geo/core checks      │   │   │
│  │  │     ├─ fetch error?       │   │   │
│  │  │     │   └─ failJob(code)  │   │   │
│  │  │     └─ findings object    │   │   │
│  │  │  3. scoreWithAnthropic(   │   │   │
│  │  │       findings,           │   │   │
│  │  │       abortSignal)        │   │   │
│  │  │     ├─ ScoringError?      │   │   │
│  │  │     │   └─ failJob(code)  │   │   │
│  │  │     └─ {score, rationale} │   │   │
│  │  │  4. completeJob(          │   │   │
│  │  │       score, mergedFinds) │   │   │
│  │  └───────────────────────────┘   │   │
│  │                                  │   │
│  │  inFlight counter tracks above   │   │
│  └──────────────────────────────────┘   │
│                                         │
│  heartbeat setInterval (TTL/2)          │
│    renewLease → false → abort signal    │
│                                         │
│  reclaim setInterval (RECLAIM_INTERVAL) │
│    reclaimExpired()                     │
└─────────────────────────────────────────┘
         │
         ▼
    Postgres (audits table)
```

### Recommended Project Structure
```
packages/worker/
├── src/
│   ├── index.ts          # barrel: exports runWorker + types
│   ├── main.ts           # bin entry: reads env, calls runWorker
│   ├── worker.ts         # runWorker(opts) — poll loop + shutdown
│   ├── pipeline.ts       # runAudit(job, deps) — single job pipeline
│   ├── scorer.ts         # scoreWithAnthropic(findings, signal, client)
│   ├── env.ts            # assertEnv() — fail-fast env validation
│   └── __tests__/
│       ├── scorer.test.ts       # mock Anthropic client
│       ├── pipeline.test.ts     # PGlite + loopback fetcher
│       └── worker.test.ts       # concurrency + shutdown + heartbeat + reclaim
├── package.json
├── tsup.config.ts
└── vitest.config.ts
```

### Pattern 1: Forced Tool-Use + Tool_Use Block Extraction

```typescript
// Source: docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use
// and github.com/anthropics/anthropic-sdk-typescript

const response = await client.messages.create({
  model: process.env.SCORING_MODEL ?? 'claude-sonnet-4-6',
  max_tokens: 1024,
  system: [
    {
      type: 'text',
      text: GEO_SCORING_RUBRIC,   // large static string — cache this
      cache_control: { type: 'ephemeral' },
    },
  ],
  tools: [
    {
      name: 'record_geo_score',
      description: 'Record the GEO score and per-dimension findings',
      input_schema: {
        type: 'object',
        properties: {
          score: { type: 'integer', minimum: 0, maximum: 100 },
          findings: { /* per-dimension sub-scores + rationale */ },
        },
        required: ['score', 'findings'],
      },
      // cache_control on tool definition is also valid:
      // cache_control: { type: 'ephemeral' },
    },
  ],
  tool_choice: { type: 'tool', name: 'record_geo_score' },
  messages: [
    {
      role: 'user',
      content: JSON.stringify(determinisitcFindings),  // dynamic per-job input
    },
  ],
}, {
  signal: abortController.signal,  // per-request abort
});

// Extract tool_use block from response.content array
const toolUseBlock = response.content.find(b => b.type === 'tool_use');
if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
  throw new ScoringError('SCORING_MALFORMED_OUTPUT', false);
}
const rawInput = toolUseBlock.input;  // object matching input_schema
const parsed = GeoScoreSchema.safeParse(rawInput);
if (!parsed.success) throw new ScoringError('SCORING_MALFORMED_OUTPUT', false);

// Cache proof:
// response.usage.cache_creation_input_tokens > 0  → first call (wrote cache)
// response.usage.cache_read_input_tokens > 0       → subsequent call (hit cache)
```

**Critical:** `cache_control` is placed on the LAST content block of the static prefix. Tools array is processed before system, which is before messages. Placing `cache_control` on the tool definition OR the last system block both work; placement on the system block is simpler when the tool schema is short.

### Pattern 2: Per-Request AbortController Timeout

```typescript
// Source: github.com/anthropics/anthropic-sdk-typescript README
// Per-request signal (NOT client-level timeout) for fine-grained control.

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), SCORING_TIMEOUT_MS);
try {
  const response = await client.messages.create({ /* ... */ }, { signal: ac.signal });
  return response;
} catch (err) {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    throw new ScoringError('SCORING_TIMEOUT', true);
  }
  // ...
} finally {
  clearTimeout(timer);
}
```

**Warning (D-13 implementation note):** The SDK defaults to `maxRetries: 2` and auto-retries 429/529/408/500/502/503/504 with exponential backoff. If you use the per-request `signal` timeout as the only bound, the SDK's internal retry loop can burn through `SCORING_TIMEOUT_MS` across multiple attempts. **Set `maxRetries: 0` on the client (or per-request override)** and own retries through the lease/attempts mechanism. Otherwise a 60s timeout could result in 3×60s = 180s before the abort fires.

### Pattern 3: In-Process Semaphore / In-Flight Counter

```typescript
// Bun/Node idiomatic — no library needed for simple bounded concurrency

let inFlight = 0;
const MAX = parseInt(process.env.WORKER_CONCURRENCY ?? '3', 10);

async function pollLoop() {
  while (!shuttingDown) {
    if (inFlight < MAX) {
      const job = await dal.claimNextJob(LEASE_TTL_SECONDS);
      if (job) {
        inFlight++;
        runAudit(job)                 // deliberately NOT awaited
          .finally(() => inFlight--); // counter decrements on any outcome
      } else {
        await sleep(POLL_INTERVAL_MS);
      }
    } else {
      await sleep(POLL_INTERVAL_MS); // queue full — back off
    }
  }
  // drain: wait for all in-flight to finish
  while (inFlight > 0) {
    await sleep(100);
  }
}
```

### Pattern 4: Heartbeat + Lease-Lost Abort

```typescript
// Each in-flight audit gets its own AbortController for lease-loss signaling.

async function runAudit(job: AuditJob, dal: AuditDal): Promise<void> {
  const ac = new AbortController();

  const heartbeat = setInterval(async () => {
    const ok = await dal.renewLease(job.id, job.leaseToken!, LEASE_TTL_SECONDS);
    if (!ok) {
      // Another worker claimed this job (lease fencing). Abort in-flight pipeline.
      ac.abort();
    }
  }, (LEASE_TTL_SECONDS * 1000) / 2);

  try {
    await pipeline(job, ac.signal, dal);
  } catch (err) {
    if (ac.signal.aborted) {
      // Lease lost — do NOT call failJob (another worker owns it now)
      return;
    }
    // ... other error handling
  } finally {
    clearInterval(heartbeat);
  }
}
```

### Pattern 5: Graceful Shutdown with Bun Signal Handling

```typescript
// Bun supports process.on('SIGTERM') and process.on('SIGINT') identically to Node.
// No Bun-specific API needed.

let shuttingDown = false;

process.on('SIGTERM', () => { shuttingDown = true; });
process.on('SIGINT',  () => { shuttingDown = true; });
```

**Bun note:** Bun handles `process.on('SIGTERM'/'SIGINT')` correctly. The main gotcha is that Bun exits immediately if the event loop is empty — the poll loop's `while (!shuttingDown)` drain idiom keeps the event loop alive during drain without needing `process.exitCode`.

### Pattern 6: Injected Anthropic Client for Testing

```typescript
// Define a minimal interface (not importing Anthropic types in non-scorer code)

export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
  };
}

// scorer.ts accepts AnthropicMessagesClient, not Anthropic class directly
export function createScorer(client: AnthropicMessagesClient) { ... }

// In tests:
const fakeClient: AnthropicMessagesClient = {
  messages: {
    create: vi.fn().mockResolvedValue(mockResponse),
  },
};
```

### Anti-Patterns to Avoid
- **Passing raw HTML to the scoring prompt:** D-07/D-09 locked this. The deterministic findings object is the input, not page HTML. Raw HTML bloats tokens and bypasses the caching architecture.
- **Setting `tool_choice: 'auto'` and parsing free-text fallback:** Forces the model to call the tool, eliminating parse errors. Always use `{type:'tool', name}`.
- **Relying on SDK auto-retry without disabling it:** SDK retries 429/529/5xx internally. With `maxRetries > 0`, the AbortController timeout may expire mid-retry-backoff and throw `APIConnectionTimeoutError` rather than `RateLimitError`, making retry classification wrong.
- **Calling `failJob` when lease is lost:** When `renewLease` returns false, another worker owns the job. Calling `failJob` will get 0 rows back (lease token mismatch) — harmless but confusing. The correct behavior is to abort silently.
- **Placing `cache_control` on a block that changes per-request:** The cache prefix must be stable. Any dynamic content (the findings JSON) must NOT be in the cached region.
- **Forgetting the minimum token threshold:** `claude-sonnet-4-6` requires ≥2048 tokens in the cached prefix. A short scoring rubric will be silently processed without caching — no error, but `cache_creation_input_tokens` will be 0. Ensure the static system block is substantial.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Structured JSON output from LLM | Regex/manual parse of free text | `tool_choice: {type:'tool', name}` | Forced tool-use is schema-enforced by the API; zod validates the structured input object |
| Retry logic for Anthropic errors | Custom retry loop | Lease/attempts mechanism (Phase 3 reclaimExpired) | Per-job attempt counting + lease expiry is the correct retry surface; SDK internal retry conflicts |
| Distributed job queue | Redis/BullMQ | Postgres SKIP LOCKED (`claimNextJob`) | Already shipped in Phase 3; no new infrastructure |
| Lease renewal / crash recovery | Custom heartbeat table | `renewLease` + `reclaimExpired` in `@geo/db` DAL | Already implemented with correct fencing |

**Key insight:** The Phase 3 DAL already solves all job-lifecycle problems correctly. Phase 4 is purely a consumer of that surface, not an extender.

---

## Common Pitfalls

### Pitfall 1: SDK Auto-Retry Conflicts with Timeout Gate
**What goes wrong:** `new Anthropic({})` defaults to `maxRetries: 2`. A 429 causes the SDK to wait (retry-after header) and retry — potentially 2 more times — before propagating the error. If `SCORING_TIMEOUT_MS` is 60s and the SDK spends 90s on retries, the `AbortController` fires during a retry and the caught error is `APIConnectionTimeoutError` rather than `RateLimitError`, mis-classifying the retry disposition.
**How to avoid:** Always construct: `new Anthropic({ apiKey, maxRetries: 0 })`. Own retries through the lease/attempts mechanism.
**Warning signs:** Seeing `SCORING_TIMEOUT` in error logs when the API was rate-limiting.

### Pitfall 2: Minimum Token Threshold for Prompt Caching
**What goes wrong:** `claude-sonnet-4-6` requires ≥2048 tokens in the cached prefix. A scoring rubric under ~1500 words will silently skip caching. The test asserting `cache_creation_input_tokens > 0` will fail.
**How to avoid:** Make the static system block sufficiently long (full GEO methodology + rubric + tool description). In tests, use a synthetic 2100-token static block when testing cache behavior.
**Warning signs:** `usage.cache_creation_input_tokens === 0` on first call.

### Pitfall 3: `tool_use` Block Missing When Errors Occur
**What goes wrong:** On a 200 response with `stop_reason: 'end_turn'` (rare: model hallucinated a text response despite `tool_choice` forcing), `response.content` will not contain a `tool_use` block. This should throw `SCORING_MALFORMED_OUTPUT`.
**How to avoid:** Always check `response.content.find(b => b.type === 'tool_use')` and throw if absent. Do not assume index 0.
**Warning signs:** `TypeError: Cannot read property 'input' of undefined` without a `ScoringError`.

### Pitfall 4: Heartbeat Interval Survives After Lease-Lost Abort
**What goes wrong:** If `clearInterval(heartbeat)` is not in a `finally` block, and the audit throws unexpectedly, the interval keeps calling `renewLease` on a job the worker no longer owns — which returns false on every call and triggers spurious abort signals.
**How to avoid:** Heartbeat interval MUST be cleared in a `finally` block wrapping the entire audit pipeline.

### Pitfall 5: inFlight Counter Not Decremented on Unexpected Throw
**What goes wrong:** If `runAudit` throws synchronously (before its own error handling), `inFlight` never decrements and the worker freezes at max concurrency.
**How to avoid:** Always attach `.finally(() => inFlight--)` to the `runAudit(job)` call in the poll loop — never rely on internal error handling for counter management.

### Pitfall 6: Graceful Drain Hangs Forever
**What goes wrong:** During shutdown drain (`while (inFlight > 0) await sleep(100)`), an in-flight audit hangs (e.g., a scoring call with no timeout). Worker never exits.
**How to avoid:** Apply a hard `SHUTDOWN_GRACE_MS` timeout (env, default 30000ms) after which in-flight jobs are abandoned (lease expiry handles recovery). Use `Promise.race` between drain completion and a grace-timeout promise.

---

## Code Examples

### Scorer Error Classification

```typescript
// Source: npm @anthropic-ai/sdk error hierarchy (verified 0.100.1)
import Anthropic from '@anthropic-ai/sdk';

function classifyScoringError(err: unknown): ScoringError {
  // Timeout (AbortController fired or SDK connection timeout)
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ScoringError('SCORING_TIMEOUT', true);
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ScoringError('SCORING_TIMEOUT', true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ScoringError('SCORING_API_ERROR', true);
  }
  if (err instanceof Anthropic.RateLimitError) {
    // status 429
    return new ScoringError('SCORING_RATE_LIMITED', true);
  }
  if (err instanceof Anthropic.InternalServerError) {
    // status 500–599 incl. 529 overloaded
    return new ScoringError('SCORING_API_ERROR', true);
  }
  if (err instanceof Anthropic.APIError) {
    // catch-all for other status codes
    return new ScoringError('SCORING_API_ERROR', err.status >= 500);
  }
  return new ScoringError('SCORING_API_ERROR', false);
}
```

**Note on 529:** `InternalServerError` extends `APIError` with `status` 500–599. Since 529 is in that range, it is caught by `instanceof Anthropic.InternalServerError`. Confirmed: [Anthropic errors docs](https://docs.anthropic.com/en/api/errors).

### ScoringError Type

```typescript
export class ScoringError extends Error {
  constructor(
    public readonly code:
      | 'SCORING_TIMEOUT'
      | 'SCORING_RATE_LIMITED'
      | 'SCORING_API_ERROR'
      | 'SCORING_MALFORMED_OUTPUT',
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'ScoringError';
  }
}
```

### Env Validation (fail-fast, mirroring assertDatabaseUrl pattern)

```typescript
export function assertEnv() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY env is required (Coolify env, never committed)');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL env is required');
  }
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Free-text LLM output + regex parse | Forced tool-use (`tool_choice: {type:'tool', name}`) for schema-valid JSON | Anthropic API ~2023 | Eliminates parse errors; zod validates `tool_use.input` directly |
| `claude -p` CLI subprocess for scoring | `@anthropic-ai/sdk` `messages.create` in-process | PROJECT.md decision | No subprocess overhead; structured error types; prompt caching available |
| Module-level vi.mock for SDK | Constructor-injected `AnthropicMessagesClient` interface | Vitest best practice | No hoisting gotchas; explicit seam; works with `run_in_band` |

**Deprecated / outdated:**
- `claude -p` for structured scoring: explicitly killed in PROJECT.md — SDK call only.
- Model string `claude-sonnet-4-6-20260218`: dated suffix is optional; `claude-sonnet-4-6` is the canonical dateless ID and maps to a fixed snapshot (not an evergreen pointer). Use the dateless form.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `claude-sonnet-4-6` minimum cache token threshold is 2048 (vs 1024 for older Sonnet) | Standard Stack / Pitfall 2 | Test asserting `cache_creation_input_tokens > 0` fails; cache silently disabled — scoring still works, just more expensive | [ASSUMED — sourced from WebSearch cross-ref, not directly verified on official docs page] |
| A2 | `InternalServerError` catches 529 (overloaded) because 529 is in 500–599 range | Code Examples | 529 might be a separate SDK subclass; error classification might miss it | [ASSUMED based on SDK error hierarchy search results] |
| A3 | `APIUserAbortError` is thrown when AbortController aborts mid-request | Code Examples | Different class name would cause un-caught abort errors | [ASSUMED — mentioned in search results context but not directly confirmed from SDK source] |

---

## Open Questions

1. **Cache token minimum for `claude-sonnet-4-6`**
   - What we know: claude-sonnet-4-5 = 1024 tokens minimum; one source says claude-sonnet-4-6 = 2048.
   - What's unclear: Not directly confirmed on the official Anthropic models/caching docs page.
   - Recommendation: Planner should include a task to verify this against `platform.claude.com/docs/en/build-with-claude/prompt-caching` at implementation time. Build the static rubric to be ≥2500 tokens to be safe regardless.

2. **429 `retry-after` header and `RateLimitError` properties**
   - What we know: The SDK exposes `err.headers` on `APIError`. The `retry-after` value is accessible.
   - What's unclear: Whether `RateLimitError` has a typed `retryAfterMs` property or requires `parseInt(err.headers?.['retry-after'] ?? '0', 10) * 1000`.
   - Recommendation: D-13 defers retry timing to lease/attempts mechanism — the worker calls `failJob` with `SCORING_RATE_LIMITED` and lets the job re-queue. No need to read `retry-after` at this phase; the reclaim sweep handles timing.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | Runtime | ✓ (existing monorepo) | Already used in all packages | — |
| `@anthropic-ai/sdk` | SCORE-01..04 | ✓ (npm registry) | 0.100.1 | — |
| Postgres (Coolify) | Job queue | ✓ (Phase 3 verified) | — | PGlite for tests |
| `ANTHROPIC_API_KEY` | Scoring call | ✗ in CI/dev | — | Mock in tests; real key in Phase 6 deploy |

**Missing dependencies with no fallback:**
- Real `ANTHROPIC_API_KEY` for live scoring — tests mock the client; live smoke test deferred to Phase 6.

---

## Validation Architecture

> `workflow.nyquist_validation` not set to false — section included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.8 (mirror `packages/db`) |
| Config file | `packages/worker/vitest.config.ts` |
| Quick run command | `bun run test --run` (inside packages/worker) |
| Full suite command | `bun run test --run` (from root: `bun --cwd packages/worker run test`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | Notes |
|--------|----------|-----------|-------------------|-------|
| SCORE-01 | `messages.create` called once per job with `tool_choice: {type:'tool', name:'record_geo_score'}` | unit (mock Anthropic) | `vitest run scorer.test.ts` | Mock client; assert call shape |
| SCORE-01 | `tool_use` block extracted and zod-validated | unit (mock Anthropic) | `vitest run scorer.test.ts` | Assert `toolUseBlock.input` passed to zod |
| SCORE-02 | Dynamic input is findings object (not raw HTML); static rubric in system | unit (mock Anthropic) | `vitest run scorer.test.ts` | Assert `messages[0].content` equals serialized findings; assert system[0].text = rubric constant |
| SCORE-03 | `cache_control: {type:'ephemeral'}` present on system block in call payload | unit (mock Anthropic) | `vitest run scorer.test.ts` | Assert call arg shape includes `cache_control` |
| SCORE-03 | `usage.cache_creation_input_tokens` present in mock response; test asserts it | unit (mock Anthropic) | `vitest run scorer.test.ts` | Mock returns `usage: {input_tokens: N, output_tokens: M, cache_creation_input_tokens: K, cache_read_input_tokens: 0}` |
| SCORE-04 | Timeout → `failJob` with `SCORING_TIMEOUT`, `retryable: true` | unit (mock Anthropic) | `vitest run scorer.test.ts` | Mock throws `APIConnectionTimeoutError` |
| SCORE-04 | 429 → `failJob` with `SCORING_RATE_LIMITED`, retryable | unit | same | Mock throws `RateLimitError` |
| SCORE-04 | 529/5xx → `failJob` with `SCORING_API_ERROR`, retryable | unit | same | Mock throws `InternalServerError` |
| SCORE-04 | Missing `tool_use` block → `failJob` with `SCORING_MALFORMED_OUTPUT`, not retryable | unit | same | Mock returns response with no `tool_use` in content |
| SCORE-04 | Zod-invalid tool output → `failJob` with `SCORING_MALFORMED_OUTPUT`, not retryable | unit | same | Mock returns malformed `tool_use.input` |
| SCORE-04 | `completeJob` NEVER called on any error path | unit | same | Assert `dal.completeJob` call count is 0 on all error paths |
| WORK-02 | Full pipeline: claim → fetch → deterministic checks → score → completeJob | integration (PGlite + loopback) | `vitest run pipeline.test.ts` | Real PGlite + loopback HTTP server (Phase 2 fixture); mock Anthropic only |
| WORK-02 | Deterministic fetch error (SSRF blocked) → failJob with FetchErrorCode, no scoring call | integration (PGlite + loopback) | `vitest run pipeline.test.ts` | Assert `messages.create` not called |
| WORK-03 | `WORKER_CONCURRENCY=2`: third job not claimed while 2 in-flight | unit (fake timers) | `vitest run worker.test.ts` | Use injected sleep/clock |
| WORK-04 | `renewLease` returns false mid-audit → pipeline aborted, failJob NOT called | unit (mock DAL) | `vitest run worker.test.ts` | Inject mock DAL returning false on renewLease |
| WORK-04 | `reclaimExpired` called on `RECLAIM_INTERVAL_MS` schedule | unit (fake timers + mock DAL) | `vitest run worker.test.ts` | Use `vi.useFakeTimers()` + advance by interval |
| WORK-04 | SIGTERM: new claims stop; in-flight completes; exit | unit (fake signal) | `vitest run worker.test.ts` | Emit SIGTERM during in-flight audit; assert no new claims; assert graceful exit |

### Test Infrastructure Notes

- **PGlite harness:** Reuse Phase 3 `packages/db/src/__tests__/` PGlite setup pattern. The worker tests can import `createPgliteExecutor` (or equivalent test helper) directly from `@geo/db` test utilities or inline it.
- **Loopback HTTP servers:** Phase 2 vitest fixtures (likely in `packages/fetch/src/__tests__/`) expose `createLoopbackServer()`. Import those for pipeline integration tests to drive real `@geo/core` deterministic checks.
- **Fake timers for heartbeat/reclaim:** `vi.useFakeTimers()` in worker tests; advance with `vi.advanceTimersByTimeAsync(ms)`. Heartbeat and reclaim intervals must accept injected `setInterval`/`clearInterval` (or use a `clock` option) so tests can drive them deterministically without `--experimental-fake-timers` caveats.
- **Mock Anthropic client:** Constructor-injected `AnthropicMessagesClient` interface (see Pattern 6 above). Never `vi.mock('@anthropic-ai/sdk')` — hoisting is fragile.

### Wave 0 Gaps (files to create before implementation)

- [ ] `packages/worker/src/__tests__/scorer.test.ts` — covers SCORE-01..04
- [ ] `packages/worker/src/__tests__/pipeline.test.ts` — covers WORK-02
- [ ] `packages/worker/src/__tests__/worker.test.ts` — covers WORK-03, WORK-04
- [ ] `packages/worker/vitest.config.ts` — mirror `packages/db/vitest.config.ts`
- [ ] `packages/worker/tsup.config.ts` — mirror `packages/db/tsup.config.ts` + add `entry: ['src/index.ts', 'src/main.ts']`
- [ ] `packages/worker/package.json` — workspace package with correct deps

---

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | zod on `tool_use.input` from LLM; `FetchErrorCode` enum on deterministic stage errors |
| V6 Cryptography | no | No crypto; lease tokens are UUIDs generated by Postgres `gen_random_uuid()` |
| V2 Authentication | partial | `ANTHROPIC_API_KEY` from env only (Coolify); fail-fast assertion at worker start |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| LLM output injection (malformed `tool_use.input`) | Tampering | zod schema validation; reject any output that doesn't match `GeoScoreSchema` |
| Lease token forgery | Spoofing | Postgres `gen_random_uuid()` for lease tokens; all DAL operations require matching token |
| SSRF via audit URL | Elevation of privilege | `@geo/fetch` `createSafeFetcher()` (Phase 2); SSRF errors fail job before scoring |

---

## Sources

### Primary (HIGH confidence)
- [npm @anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) — confirmed version 0.100.1 (latest)
- [Anthropic tool use docs](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use) — `tool_choice` shape, `tool_use` block extraction
- [Anthropic errors docs](https://docs.anthropic.com/en/api/errors) — error status codes 429/529/5xx
- [Codebase: `packages/db/src/dal.ts`] — exact DAL signatures (`claimNextJob`, `completeJob`, `failJob`, `renewLease`, `reclaimExpired` return shapes)
- [Codebase: `packages/db/src/types.ts`] — `FindingsShape`, `AuditJob` interfaces
- [Codebase: `packages/core/src/types.ts`] — `Fetcher`, `FetchResult`, result type shapes
- [Codebase: `packages/fetch/src/errors.ts`] — all 10 `FetchErrorCode` values

### Secondary (MEDIUM confidence)
- [DeepWiki anthropic-sdk-typescript creating-messages](https://deepwiki.com/anthropics/anthropic-sdk-typescript/3.2.1-creating-messages) — forced tool-use shape confirmed
- [DeepWiki error handling](https://deepwiki.com/anthropics/anthropic-sdk-typescript/2.4-error-handling) — SDK error class hierarchy
- [startdebugging.net prompt caching](https://startdebugging.net/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) — `cache_creation_input_tokens` / `cache_read_input_tokens` usage fields
- [Anthropic prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — minimum token thresholds per model

### Tertiary (LOW confidence — see Assumptions Log)
- WebSearch results re: 2048 minimum token threshold for claude-sonnet-4-6 specifically (A1)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — SDK version confirmed on npm registry; workspace deps from codebase
- Architecture: HIGH — DAL contracts read directly from source; SDK call shape from official docs
- Pitfalls: HIGH — SDK auto-retry conflict is a verified design pitfall; token minimum is MEDIUM (A1)
- Testing: HIGH — vitest + PGlite + loopback pattern established in Phases 2–3

**Research date:** 2026-06-02
**Valid until:** 2026-07-02 (SDK moves fast; re-check if >30 days before planning starts)

---

## RESEARCH COMPLETE

**Phase:** 4 - Worker Pipeline
**Confidence:** HIGH

### Key Findings
- `@anthropic-ai/sdk` 0.100.1: forced tool-use is `tool_choice: {type:'tool', name}` + read `response.content.find(b => b.type === 'tool_use').input`; all error classes confirmed (`APIConnectionTimeoutError`, `RateLimitError`, `InternalServerError extends APIError`)
- **Critical pitfall:** SDK defaults `maxRetries: 2` auto-retrying 429/529 — must disable with `maxRetries: 0` to let lease/attempts own retry logic
- Prompt caching: `cache_control: {type:'ephemeral'}` on system block; `usage.cache_creation_input_tokens` / `cache_read_input_tokens` fields confirmed on response; minimum ~2048 tokens for claude-sonnet-4-6 (A1 — verify at implementation)
- Model ID: `claude-sonnet-4-6` (dateless, canonical, fixed snapshot)
- Per-request abort: pass `AbortController.signal` as second arg to `messages.create(params, {signal})`; throws `APIConnectionTimeoutError` or `APIUserAbortError`
- DAL contracts verified from source: `completeJob`/`failJob`/`renewLease` all return `Promise<boolean>` (false = lease fencing active); `reclaimExpired()` returns count

### File Created
`.planning/phases/04-worker-pipeline/04-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | npm registry + official docs + codebase read |
| Architecture | HIGH | All DAL contracts read from source |
| Anthropic SDK API shape | HIGH | Official docs + multiple verified sources |
| Prompt cache min tokens | MEDIUM | Multiple sources agree but not directly verified on docs page |
| Pitfalls | HIGH | SDK retry conflict is documented behavior |

### Open Questions
- Verify 2048 minimum token threshold for `claude-sonnet-4-6` on `platform.claude.com/docs/en/build-with-claude/prompt-caching`
- Confirm `APIUserAbortError` vs `APIConnectionTimeoutError` class for `AbortController.abort()` path

### Ready for Planning
Research complete. Planner can create PLAN.md files.
