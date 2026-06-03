# Phase 4: Worker Pipeline - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning
**Mode:** mvp · discuss auto-mode (YOLO defaults — recommended options auto-selected)

<domain>
## Phase Boundary

Deliver a background worker that reliably runs the full audit pipeline for a claimed job: fetch (via the Phase 2 SSRF-safe fetcher) → `@geo/core` deterministic checks → a SINGLE structured `@anthropic-ai/sdk` scoring call (JSON output schema + prompt caching) → persist the 0–100 score + structured findings to Postgres via the Phase 3 `@geo/db` DAL. Concurrency is bounded; scoring failures fail the job cleanly with a retryable status (never a partial score); a crashed/stuck job is recovered via the lease/timeout mechanism.

Covers **SCORE-01, SCORE-02, SCORE-03, SCORE-04, WORK-02, WORK-03, WORK-04**. Does NOT include: the HTTP API (Phase 5 — `insertJob` on POST /audit), containerization/Coolify deploy (Phase 6), or the cron re-audit scheduler (Phase 7). WORK-01 (the SKIP LOCKED claim + lease columns + `reclaimExpired`) already shipped in Phase 3; this phase CONSUMES it.
</domain>

<decisions>
## Implementation Decisions

### Package & runtime
- **D-01:** Lives as a new workspace package `packages/worker/` (`@geo/worker`) — same tsup/vitest conventions as core/fetch/db. Exports a `runWorker(opts)` function (the long-lived poll loop) plus a thin `bin`/entry (`src/main.ts`) that Phase 6 runs as a separate Coolify service/process. Depends on `@geo/core`, `@geo/fetch`, `@geo/db`, `@anthropic-ai/sdk`. (recommended)
- **D-02:** Runtime = Bun (matches the all-TS stack). The worker is a plain async loop, no framework. (recommended)

### Concurrency model (WORK-03)
- **D-03:** Single worker process running a **claim-poll loop** that maintains up to **N in-flight audits** via an in-process semaphore/counter. N = `WORKER_CONCURRENCY` env (default **3**). When in-flight < N, claim the next job (`claimNextJob`); when the queue returns null, sleep `POLL_INTERVAL_MS` (default **1000ms**) before polling again. No Redis/Celery/BullMQ broker — Postgres SKIP LOCKED IS the broker. Horizontal scale = run more worker processes (each claims independently; SKIP LOCKED guarantees no double-claim). (recommended; satisfies WORK-03)
- **D-04:** Graceful shutdown: on SIGTERM/SIGINT stop claiming new jobs, let in-flight audits finish (bounded by a shutdown grace timeout), then exit. In-flight-but-unfinished jobs at hard timeout are left to lease-reclaim — never marked done. (recommended)

### Lease lifetime & crash recovery (WORK-04)
- **D-05:** Each claimed job holds a lease (`lease_token` + `lease_expires_at` from Phase 3). Lease TTL = `LEASE_TTL_SECONDS` env (default **120s**). For audits that may run longer than the TTL, a **heartbeat** calls `renewLease(id, leaseToken, ttl)` every `TTL/2` while the audit runs; renewal failure (zero rows — lease lost/fenced) **aborts** the in-flight audit (another worker owns it now). (recommended; SCORE-04 + WORK-04 fencing)
- **D-06:** A background **reclaim sweep** calls `reclaimExpired()` on an interval (`RECLAIM_INTERVAL_MS`, default = `LEASE_TTL/2`·1000) IN ADDITION to the claim-time reclaim already in `claimNextJob`. This is the WORK-04 recovery loop: a worker killed mid-audit has its job flipped `running → queued` (or `→ failed` past max attempts) and re-run. Max attempts = `MAX_ATTEMPTS` env (default **3**), enforced by the Phase 3 `reclaimExpired` guard. (recommended)

### Pipeline (WORK-02)
- **D-07:** Per-job pipeline order: (1) build the SSRF-safe fetcher via `@geo/fetch` `createSafeFetcher()` and INJECT it into the `@geo/core` functions (the Phase 1/2 `Fetcher` seam — no direct network in core); (2) run the deterministic `@geo/core` checks (robots/crawl, llms.txt, schema templates, citability, SSR/CSR rendering detection) to produce a structured findings object; (3) pass the **findings object (NOT raw HTML)** as the scoring call's dynamic input; (4) on success `completeJob({id, leaseToken, score, findings})`, on failure `failJob({id, leaseToken, errorCode})`. (recommended; SCORE-02 + WORK-02)
- **D-08:** A deterministic-stage error (fetch SSRF block, DNS failure, oversize — the 10 Phase 2 error codes) fails the job with that error code WITHOUT making a scoring call (no point scoring a page we couldn't fetch). The findings object shape and the persisted `findings jsonb` reuse `@geo/core` result types (CrawlData, CitabilityResult, StructuredDataValidationResult, rendering, llms.txt). (recommended)

### Scoring call (SCORE-01/02/03/04)
- **D-09:** ONE structured call via `@anthropic-ai/sdk` `messages.create` using **forced tool-use** for schema-valid JSON: define a single tool (e.g. `record_geo_score`) whose `input_schema` is the score contract, set `tool_choice: { type: "tool", name: "record_geo_score" }`, and read the structured result from the `tool_use` block. No `claude -p`, no agent host, no free-text-then-parse. (recommended; SCORE-01)
- **D-10:** Score output contract: `{ score: int 0–100, findings: { <per-dimension sub-scores + rationale strings> } }`, validated with **zod** after extraction. The deterministic `@geo/core` findings are the INPUT; the LLM renders only the irreducible judgment (weighting/synthesis into 0–100). Persisted `score` = the int; persisted `findings jsonb` = deterministic findings + the LLM rationale merged. (recommended; SCORE-02)
- **D-11:** Model = `claude-sonnet-4-6` (balanced cost/quality for a single judgment call; configurable via `SCORING_MODEL` env). Anthropic API key from `ANTHROPIC_API_KEY` env ONLY (Coolify env in Phase 6), fail-fast if missing at worker start. (recommended)
- **D-12:** **Prompt caching (SCORE-03):** the large STATIC portion (scoring rubric/system instructions + tool schema description + the GEO scoring methodology) is a system block with `cache_control: { type: "ephemeral" }`; only the per-job findings are dynamic/uncached. Test asserts `usage.cache_creation_input_tokens` (first call) / `cache_read_input_tokens` (subsequent) are present in the response — proving the cache is wired, not just configured. (recommended; SCORE-03)
- **D-13:** **Failure handling (SCORE-04) — UPDATED per cross-AI review:** wrap the scoring call in an `AbortController` timeout (`SCORING_TIMEOUT_MS`, default **60000**). Timeout, Anthropic rate-limit (429) / overloaded (529) / 5xx, missing `tool_use` block, or zod-invalid output → throw a typed `ScoringError` carrying a machine-readable `error_code` (`SCORING_TIMEOUT`, `SCORING_RATE_LIMITED`, `SCORING_API_ERROR`, `SCORING_MALFORMED_OUTPUT`). **ALL of these are `retryable: true`** — ROADMAP success criterion #4 explicitly says "times out OR returns malformed output → failed with a *retryable* status." (The earlier draft marked malformed non-retryable; cross-AI review caught the contradiction. MAX_ATTEMPTS bounds the retries, so a deterministically-malformed model can't loop forever — it lands terminal after the cap.) **No partial score is ever written** — only the success path calls `completeJob`. (SCORE-04)
- **D-15:** **Retry path (cross-AI review HIGH):** Phase-3 `failJob` is TERMINAL (`status='failed'`, lease cleared) and `reclaimExpired()` only requeues expired *running* rows — so a "retryable" failure that called `failJob` would never re-enter the queue. Therefore: add a lease-fenced **`requeueJob({id, leaseToken, errorCode})`** to the `@geo/db` DAL (Phase 3 package — additive, non-breaking) that sets `status='queued'`, records `error_code`, and clears `lease_token`/`locked_at`/`lease_expires_at` (keeping the already-incremented `attempts`), with `WHERE id=$id AND lease_token=$tok AND status='running'`, `RETURNING id`, false on zero rows. **Worker policy:** on a `ScoringError`, if `retryable && attempts < MAX_ATTEMPTS` → `requeueJob` (back to queue, gets re-claimed); else → `failJob` (terminal). A deterministic-stage fetch error (non-retryable by nature) → `failJob` directly. This addition gets its own PGlite test (requeue→re-claimable; terminal after MAX_ATTEMPTS). (cross-AI review; SCORE-04 + WORK-04)
- **D-16:** **Lease-fenced boolean + lifecycle hardening (cross-AI review HIGH/MED):** `completeJob`/`failJob`/`requeueJob`/`renewLease` return `false` on a stale/lost lease — the worker MUST handle `false` (log lease-loss, do NOT re-write; another worker owns the job). In-flight audits are tracked in a `Set<Promise<void>>` with `.catch(logAndFail).finally(removeFromSet)` so a rejected `runAudit` can never become an unhandled rejection (Bun would crash). Check `signal.aborted` before the scoring call AND before any DAL write. Deterministic-stage **sub-fetch** errors (robots/crawl/etc. perform additional fetches via the injected `Fetcher`) must also short-circuit to `failJob`/`requeueJob` before scoring. SIGTERM/SIGINT handlers are removed in `finally` to avoid listener accumulation across test runs. (cross-AI review)

### Testing
- **D-14:** Vitest. The Anthropic SDK is the ONLY external dependency mocked (no live API spend in CI) — mock the client to assert: (a) exactly ONE `messages.create` call per job, (b) tool-use forced with the right tool name, (c) `cache_control` present on the static block, (d) the findings object (not raw HTML) is the dynamic input, (e) timeout/429/5xx/malformed each map to the correct `error_code`, are all `retryable: true`, and route to `requeueJob` (attempts<MAX) or `failJob` (terminal) — never `completeJob`; plus tests for `completeJob`/`requeueJob` returning `false` (stale lease handled), core sub-fetch error short-circuit, and abort-before-DAL-write. The job-state side (claim → run → complete/fail, lease renewal, reclaim) is tested against **PGlite** (real SQL, reusing the Phase 3 harness). A small fake-clock or injected timers drive the heartbeat/reclaim interval tests deterministically. The `@geo/core` checks run for real against loopback fixtures (reuse Phase 2 test servers). Never mock SKIP LOCKED or the DAL. (recommended)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project / requirements
- `.planning/REQUIREMENTS.md` §Scoring (SCORE-01..04) + §Worker/Job Runner (WORK-02/03/04)
- `.planning/ROADMAP.md` — Phase 4 goal + 5 success criteria
- `.planning/PROJECT.md` — "scoring = structured Anthropic SDK call (JSON schema + prompt caching), NOT claude -p / agent host" decision + all-TS stack

### Phase contracts this phase consumes (read the SUMMARYs + barrels)
- `.planning/phases/03-postgres-schema-durable-job-queue/03-CONTEXT.md` — D-08/D-09/D-10: `claimNextJob` (returns row incl. `leaseToken`), `completeJob`/`failJob`/`renewLease` (require matching `lease_token`, false on zero rows), `reclaimExpired()`, max-attempts guard
- `packages/db/src/index.ts` + `packages/db/src/dal.ts` — `createAuditDal(sql)` / `AuditDal` typed surface
- `packages/core/src/index.ts` — deterministic check functions + the injected `Fetcher`/`FetchResult` seam (`@geo/core` types)
- `packages/fetch/src/index.ts` — `createSafeFetcher()` + the 10 SSRF/fetch error codes (deterministic-stage failures map to these)
- `.planning/phases/01-geo-core-deterministic-package/01-CONTEXT.md` — D-05 injected fetch seam, result-type shapes
- `.planning/phases/02-ssrf-fetch-hardening/02-CONTEXT.md` — error-code contract

### Stack rules
- Global rule 21 (all-TS) · global rule 17/Coolify env for secrets (ANTHROPIC_API_KEY, DATABASE_URL never committed)

### External
- `@anthropic-ai/sdk` — `messages.create`, forced tool-use (`tool_choice`), and prompt caching (`cache_control: {type:'ephemeral'}`, `usage.cache_creation_input_tokens` / `cache_read_input_tokens`). Researcher MUST confirm current SDK shape via context7 / official docs before planning.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@geo/db` `createAuditDal(sql)` — the entire job lifecycle API (claim/complete/fail/renew/reclaim) already exists and is lease-fenced. The worker is a CONSUMER; it adds zero SQL.
- `@geo/core` deterministic functions + injected `Fetcher` seam — the worker wires `createSafeFetcher()` into them.
- `@geo/fetch` `createSafeFetcher()` + error codes — deterministic-stage fetch failures.
- Phase 2 loopback test servers + Phase 3 PGlite harness — reuse for Phase 4 integration tests.

### Established Patterns
- Workspace package layout (core/fetch/db) — `packages/worker` follows the same tsup dual-build + vitest conventions.
- Typed-contract / structured-result discipline; env-only secrets with fail-fast assert (mirror `assertDatabaseUrl`).

### Integration Points
- Phase 5 API calls `insertJob` to enqueue; this worker drains the same queue.
- Phase 6 runs `@geo/worker` as a separate Coolify service; ANTHROPIC_API_KEY + DATABASE_URL from Coolify env.
- Phase 7 cron enqueues via the API → same worker.
</code_context>

<specifics>
## Specific Ideas

The single-structured-call discipline is the heart of this phase: deterministic `@geo/core` findings are the INPUT, the LLM renders ONLY the 0–100 judgment via forced tool-use, and the static rubric is prompt-cached (proven by usage metadata, not just configured). The lease heartbeat + reclaim sweep are what make "no job stranded `running` after a crash" TRUE under real concurrency. SCORE-04's "never a partial score" is structurally guaranteed: only the success path calls `completeJob`.
</specifics>

<deferred>
## Deferred Ideas

- Multi-step tool-use-DURING-an-audit driver (agent-host scoring) — explicitly killed in PROJECT.md; revisit only if a real driver #3 emerges. Out of scope.
- Idempotency keys on enqueue → v2 OPS-02.
- Cron re-audit scheduler → Phase 7. Container packaging / separate Coolify service wiring → Phase 6.
- Live-API scoring smoke test (real Anthropic spend) → optional Phase 6 deploy-verify, gated behind a real key.
</deferred>

---

*Phase: 4-Worker Pipeline*
*Context gathered: 2026-06-02 (auto-mode, YOLO defaults)*
