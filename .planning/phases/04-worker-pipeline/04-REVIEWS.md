---
phase: 4
reviewers: [gemini, codex]
reviewed_at: 2026-06-02
plans_reviewed: [04-00-PLAN.md, 04-01-PLAN.md, 04-02-PLAN.md]
self_skipped: claude (CLAUDE_CODE_ENTRYPOINT=cli)
---

# Cross-AI Plan Review — Phase 4 (Worker Pipeline)

## Gemini Review

# Phase 4 (Worker Pipeline) Plan Review

## Summary
Phase 4 implements a robust, concurrent background worker using **Bun** that polls **Postgres** (via SKIP LOCKED) to execute a multi-stage audit pipeline: SSRF-safe fetch → deterministic `@geo/core` checks → single structured **Anthropic SDK** judgment → lease-fenced persistence. The design emphasizes a "lean LLM" approach where cost and latency are minimized through prompt caching and offloading 80% of the logic to deterministic code.

## Strengths
- **Fenced Persistence**: Using `lease_token` in `completeJob`/`failJob` combined with a heartbeat `renewLease` (D-05) effectively prevents "double-score" race conditions if a worker hangs or crashes.
- **Testing Fidelity**: Reusing the **PGlite** harness and loopback test servers (D-14) allows for high-confidence integration testing of the `claim → run → complete` lifecycle without live API spend.
- **Deterministic-First Pipeline**: Short-circuiting the audit on fetch errors (D-08) before hitting the LLM is a critical cost-saving measure.
- **Injection Seams**: Decoupling the Anthropic SDK via `AnthropicMessagesClient` (04-00) ensures unit tests are isolated from module hoisting issues and fragile `vi.mock()` calls.

## Concerns
- **[MEDIUM] SDK Retry Interference**: RESEARCH Pitfall 1 identifies that `@anthropic-ai/sdk` defaults to `maxRetries: 2`. While 04-02 Task 3 mentions setting `maxRetries: 0`, this is a high-impact requirement that should be enforced via the `createScorer` factory or a runtime check to prevent the SDK from masking 429/5xx errors behind a generic `APIConnectionTimeoutError` when the `AbortController` fires.
- **[LOW] Cache Token Threshold**: Sonnet 4.6 requires a **2048 token minimum** for caching (A1). If the `GEO_SCORING_RUBRIC` is too concise, SCORE-03 will silently fail. The plan should explicitly verify the rubric length or "pad" the system block with the full scoring methodology to ensure the threshold is hit.
- **[LOW] Heartbeat Sensitivity**: D-05 aborts the audit immediately on `renewLease` failure. If the failure is a transient DB connection issue (not a lost lease), the audit is unnecessarily aborted. A single retry on `renewLease` inside the heartbeat could improve resilience.
- **[MEDIUM] Memory Exhaustion**: If `WORKER_CONCURRENCY` is high and several concurrent audits fetch large pages or generate huge `FindingsShape` objects, the Bun process could OOM. Plan 04-02 should ensure `createSafeFetcher` (from Phase 2) has `RESPONSE_SIZE_CAP` strictly enforced.

## Suggestions
- **Metric Tracking**: In `pipeline.ts`, extract `cache_read_input_tokens` from the Anthropic response and log it. This provides a clear production signal that SCORE-03 (caching) is actually working.
- **Error Propagation**: Ensure `failJob` machine-readable `error_code` correctly distinguishes between `FETCH_ERROR` codes and `SCORING_ERROR` codes to help Phase 7 (scheduled re-audits) decide which failures are worth immediate retries.
- **Schema Validation**: In `scorer.ts`, consider adding a `total_score` check in the `findings` object rationale to ensure the LLM's sub-scores actually sum to the returned `score`.

## Overall Risk: LOW
The plans are exceptionally detailed, specifically address known SDK pitfalls (prompt caching, forced tool-use), and leverage the hardened DAL from Phase 3. The risk of scope creep is low due to the strict separation of the worker from the HTTP API (Phase 5).

---

## Codex Review

## Summary

The plans are mostly aligned with Phase 4 and have good separation: scaffold → scorer → pipeline/loop. As written, risk is **HIGH** because retry semantics, option types, and async worker lifecycle have contradictions that can fail the stated success criteria.

## Strengths

- Clear dependency ordering across `04-00`, `04-01`, `04-02`.
- Good single-call scoring discipline in `04-01`: forced `tool_choice`, zod validation, no `claude -p`.
- Good security posture around SSRF: `04-02` intends `createSafeFetcher()` as the only fetch path.
- Strong test intent: injected Anthropic client, PGlite DAL tests, fake timers for lease/reclaim.
- `maxRetries: 0` in `main.ts` is the right call; SDK retries would fight worker-owned retry logic.

## Concerns

- **[HIGH] `04-01` conflicts with Success Criteria #4.** Malformed output is planned as `SCORING_MALFORMED_OUTPUT`, `retryable=false`, but the phase says timeout or malformed output must fail with a retryable status code.
- **[HIGH] Retry mechanics are underspecified.** `04-02` calls `dal.failJob(...)` for scoring errors. If `failJob` is terminal, retryable scoring failures will never re-enter the queue. `reclaimExpired()` only helps expired `running` jobs unless Phase 3 explicitly requeues failed retryable jobs.
- **[HIGH] `WorkerOptions` does not line up.** `04-00` defines `WorkerOptions` with `dal` + `anthropic`; `04-02` needs `scorer`, `fetcher`, `clock/sleep`, and maybe `runAudit`. `packages/worker/src/types.ts` is not listed in `04-02 files_modified`, so this likely fails build or forces ad hoc types.
- **[HIGH] Fire-and-forget worker promises can become unhandled rejections.** `runAudit(...).finally(() => inFlight--)` still rejects if `runAudit` rejects. Track promises or add `.catch(...)` before/with `.finally`.
- **[HIGH] Lease-fenced writes are ignored.** `completeJob(...)` / `failJob(...)` return `boolean`; `false` means stale lease. `04-02` should explicitly handle false as lease loss, especially after an expensive scoring call.
- **[MEDIUM] Deterministic-stage fetch errors are only handled for the initial fetch.** Core checks like robots/crawl may perform additional fetches; any `FetchErrorCode` from those paths must also short-circuit before scoring.
- **[MEDIUM] Abort behavior is incomplete for non-scorer stages.** Heartbeat loss aborts `scorer.score`, but core/fetch functions may not accept `AbortSignal`. At minimum, check `signal.aborted` before scoring and before any DAL write.
- **[MEDIUM] Process signal handlers need cleanup.** `runWorker` tests or repeated invocations can accumulate `SIGTERM`/`SIGINT` listeners unless removed in `finally`.
- **[MEDIUM] Prompt-cache rubric size looks overbuilt.** Current Anthropic docs list 1,024 tokens as the cacheable minimum for Sonnet 4.6, not 2,500; avoid padding the rubric just to satisfy an outdated threshold.
- **[LOW] `min_lines` requirements are brittle.** They encourage line-count compliance instead of behavior.

## Suggestions

- Add or confirm a DAL operation/status for retryable failures: e.g. `failAttemptAndRequeue(...)`, or document that `failJob(errorCode)` keeps retryable jobs queueable until `MAX_ATTEMPTS`.
- Make malformed scoring output retryable, or change the success criterion. Do not leave them inconsistent.
- Update `WorkerOptions` in `04-02`, or split into `WorkerRuntimeOptions` and `MainEnvOptions`.
- Track in-flight work with a `Set<Promise<void>>`; always `.catch(log)` and `.finally(remove)`.
- Add tests for `completeJob=false`, `failJob=false`, core subfetch failure, external abort before DAL write, and signal-handler cleanup.
- Keep `tool_choice: {type:"tool", name:"record_geo_score"}`; Anthropic docs support this forced-tool pattern. Also consider `strict: true` if compatible with the current SDK/tool schema.

## Overall Risk

**HIGH as written.** The architecture is sound, but retry semantics and worker lifecycle issues need correction before execution.

Sources checked: Anthropic tool-use docs, prompt-caching docs, model ID docs, and SDK package retry behavior.  
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools  
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching  
- https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions  
- https://www.npmjs.com/package/%40anthropic-ai/sdk

---

## Consensus Summary

Both reviewers agree the architecture is sound: deterministic-first pipeline, forced tool-use single-call scoring, lease-fenced persistence, injected-client tests. Gemini rates risk LOW; Codex rates HIGH-as-written due to retry-semantics + worker-lifecycle gaps. The Codex HIGH issues are genuine and folded into CONTEXT/plans before execution.

### Agreed Strengths
- Fenced persistence (lease_token) prevents double-score races.
- Deterministic short-circuit before LLM saves cost (D-08).
- Injected `AnthropicMessagesClient` seam avoids fragile `vi.mock()` hoisting.
- `maxRetries: 0` correctly prevents SDK retries fighting worker-owned retry logic.

### Agreed Concerns (folded)
- **[HIGH] Retryability of malformed output** contradicts ROADMAP success criterion #4 ("times out OR returns malformed output → failed with a *retryable* status"). D-13 had it non-retryable. → FOLD: malformed/timeout/API all retryable (bounded by MAX_ATTEMPTS).
- **[HIGH] Retry path missing.** Phase-3 `failJob` is TERMINAL (status='failed', lease cleared); `reclaimExpired` only requeues expired *running* rows. A "retryable" failure calling `failJob` never re-enters the queue. → FOLD: add a lease-fenced `requeueJob({id,leaseToken,errorCode})` to `@geo/db` DAL (sets status='queued', clears lease, keeps incremented attempts); worker calls requeueJob on retryable failure when attempts<MAX_ATTEMPTS, else failJob (terminal).
- **[HIGH] WorkerOptions / types.ts mismatch.** 04-00 defines WorkerOptions(dal,anthropic); 04-02 needs scorer/fetcher/clock; types.ts not in 04-02 files_modified. → FOLD: complete WorkerOptions + add types.ts to 04-02 files_modified.
- **[HIGH] Fire-and-forget unhandled rejection.** `.finally(()=>inFlight--)` rejects unhandled if runAudit throws → Bun crash. → FOLD: track in `Set<Promise>`, `.catch(log).finally(remove)`.
- **[HIGH] Lease-fenced boolean ignored.** completeJob/failJob/requeueJob return false on stale lease; must be handled (log lease-loss, do not re-write). → FOLD.
- **[MEDIUM] Core sub-fetch errors** (robots/crawl perform extra fetches) must also short-circuit to failJob/requeue before scoring. → FOLD as clarification.
- **[MEDIUM] Check `signal.aborted`** before scoring and before any DAL write (heartbeat-loss abort). → FOLD.
- **[MEDIUM] Signal-handler cleanup** in finally to avoid listener accumulation across test runs. → FOLD.
- **[MEDIUM] Cache min-token threshold** uncertain (codex:1024, gemini:2048). → Do NOT pad rubric artificially; assert SCORE-03 via real `usage.cache_*` metadata; executor confirms threshold empirically.

### Divergent Views
- Overall risk: Gemini LOW vs Codex HIGH. Resolved by folding Codex's HIGH correctness fixes → effective risk LOW post-fold.
- Rubric size: gemini suggested padding to hit cache threshold; codex warned against padding. → Side with codex: don't pad; verify via metadata.
