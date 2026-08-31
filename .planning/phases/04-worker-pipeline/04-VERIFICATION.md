---
phase: 04-worker-pipeline
verified: 2026-06-02T18:30:00Z
status: passed
score: 7/7 must-haves verified
overrides_applied: 0
gaps: []
deferred:
  - truth: "Real prompt-cache hit against live Anthropic API (actual cache_read_input_tokens > 0 on 2nd call)"
    addressed_in: "Phase 6"
    evidence: "VALIDATION.md: 'Real prompt-cache hit against live Anthropic API ... deferred to Phase 6 deploy-verify with real key'"
human_verification:
  - test: "Live scoring round-trip with real ANTHROPIC_API_KEY"
    expected: "cache_read_input_tokens > 0 on second call to same rubric; score in [0,100]; findings object present"
    why_human: "No live API spend in CI; mock proves wiring/shape only (VALIDATION.md explicit deferral)"
---

# Phase 4: Worker Pipeline — Verification Report

**Phase Goal:** A background worker reliably runs the full audit pipeline — @geo/core deterministic checks followed by a single structured Anthropic SDK scoring call — and persists the 0–100 result.
**Verified:** 2026-06-02T18:30:00Z
**Status:** PASSED (all automated gates green; one live-API check deferred to Phase 6 by plan)
**Re-verification:** No — initial verification

---

## Test + Build Results (run by verifier)

```
packages/worker: 4 test files, 31 tests — ALL PASSED (5.03s)
packages/db:     8 test files, 50 passed + 1 skipped — ALL PASSED (11.34s)
packages/worker: build (tsup) — CLEAN
packages/db:     build (tsup) — CLEAN
```

---

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Worker runs @geo/core checks and passes FindingsShape (not raw HTML) to a single `messages.create` with JSON output schema | ✓ VERIFIED | `pipeline.ts:90-115` builds `FindingsShape`; `scorer.ts:330` single `messages.create` call; user message is `JSON.stringify(findings)` |
| 2 | Static scoring prompt is prompt-cached (cache_control ephemeral; usage metadata asserted in tests) | ✓ VERIFIED | `scorer.ts:337-339` `cache_control:{type:'ephemeral'}` on system block; `scorer.test.ts:199-241` asserts `cache_creation_input_tokens`/`cache_read_input_tokens` in usage |
| 3 | Completed job has numeric score (0–100) and structured findings persisted | ✓ VERIFIED | `pipeline.ts:158` `completeJob(job.id, leaseToken, scored.score, merged)`; `pipeline.test.ts` WORK-02a confirms persist path |
| 4 | Timeout or malformed output marks job failed with retryable status; no partial score written | ✓ VERIFIED | `scorer.ts:358` malformed→`ScoringError("SCORING_MALFORMED_OUTPUT", true)`; `scorer.test.ts:327-368` explicitly asserts `retryable:true` for MALFORMED; `pipeline.ts:158` `completeJob` only on success path (verified by test asserting call-count==0 on error paths) |
| 5 | Concurrency capped at configurable N; excess waits | ✓ VERIFIED | `worker.ts:68` `if (inFlight.size < concurrency)`; `worker.test.ts` WORK-03 test with WORKER_CONCURRENCY=2 |
| 6 | Heartbeat renewLease + reclaimExpired sweep; lost lease aborts in-flight; crashed job recoverable | ✓ VERIFIED | `pipeline.ts:64-71` heartbeat + `ac.abort()` on false; `worker.ts:59-63` reclaimExpired on interval; `worker.test.ts` WORK-04a/b tests |
| 7 | Cross-AI fixes landed: requeueJob in DAL; retryable→requeue/fail routing; in-flight Set with .catch; false-lease handled; maxRetries:0 | ✓ VERIFIED | See cross-AI fix details below |

**Score:** 7/7 truths verified

---

## Cross-AI Fix Verification (D-13/D-15/D-16)

| Fix | Location | Evidence |
|-----|----------|----------|
| `requeueJob` in DAL (lease-fenced, doesn't touch attempts increment) | `packages/db/src/dal.ts:267-285` | Grep confirmed; `packages/db/src/__tests__/requeue.test.ts` — 2 tests passing (matching lease→queued; wrong lease→false) |
| Worker routes retryable scoring fail → requeueJob(attempts<MAX) / failJob(else) | `pipeline.ts:130-137` | `if (job.attempts < maxAttempts) dal.requeueJob(...) else dal.failJob(...)` |
| In-flight `Set<Promise>` with `.catch` (no unhandled rejection) | `worker.ts:44-101` | `inFlight = new Set<Promise<void>>()` + `.catch((err)=>console.error(...)).finally(()=>inFlight.delete(p))` |
| False-lease returns from completeJob/failJob/requeueJob handled (log only, no re-write) | `pipeline.ts:82-83,131-135,141-144,158-159` | Every DAL call checks `if (!ok) console.warn(...)` — no re-throw, no re-write |
| `maxRetries: 0` on real Anthropic client | `main.ts:51-54` | `new Anthropic({ apiKey: ..., maxRetries: 0 })` |

---

## Deviation: getSchemaTemplates Omitted

**What:** `pipeline.ts` calls `validateStructuredData(html)` but NOT `getSchemaTemplates(pageData)`. `findings.schemaTemplate` is always `undefined`.

**Impact assessment:**

- **WORK-02** (full pipeline) — SATISFIED. The pipeline runs all other @geo/core checks and persists results. `schemaTemplate` being undefined is a missing dimension, not a broken pipeline.
- **SCORE-02** (dynamic input = @geo/core findings, NOT raw HTML) — SATISFIED. The scorer still receives a structured `FindingsShape` object. The rubric's "Schema Templates (0–15 points)" dimension will score conservatively per the rubric's own rule: "If a findings field is null or undefined, treat that dimension as unknown and score conservatively."

**Assessment:** This is an intentional executor scoping decision documented in 04-02. `getSchemaTemplates` is a generator (produces templates by page type) rather than a validator. `validateStructuredData` (present) covers the structured-data validation use case. The rubric handles missing dimensions gracefully. WORK-02 and SCORE-02 remain satisfied. The scoring LLM will simply award 0–4 points on the Schema Templates dimension for every audit until this is added.

**Recommendation for Phase 5/6:** Add `getSchemaTemplates` to the pipeline if the schemaTemplate dimension score is needed for meaningful GEO scores.

---

## Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `packages/worker/src/scorer.ts` | ✓ VERIFIED | Single `messages.create`, forced tool-use, cache_control, ScoringError, all retryable:true |
| `packages/worker/src/pipeline.ts` | ✓ VERIFIED | Full pipeline; completeJob success-only; requeueJob/failJob routing |
| `packages/worker/src/worker.ts` | ✓ VERIFIED | Bounded concurrency, in-flight Set, heartbeat, reclaimExpired, graceful drain |
| `packages/worker/src/main.ts` | ✓ VERIFIED | maxRetries:0, assertEnv, all WorkerOptions wired |
| `packages/worker/src/types.ts` | ✓ VERIFIED | WorkerOptions with all required fields |
| `packages/db/src/dal.ts` | ✓ VERIFIED | requeueJob present and lease-fenced |

---

## Anti-Patterns

None found. No TBD/FIXME/XXX markers in worker source. No stub patterns. No hardcoded empty returns on active paths.

---

## Human Verification Required

### 1. Live Anthropic API prompt-cache round-trip

**Test:** Make two `scorer.score()` calls against a real ANTHROPIC_API_KEY with the same GEO_SCORING_RUBRIC. Inspect `usage` on both responses.
**Expected:** First call: `cache_creation_input_tokens > 0`, `cache_read_input_tokens == 0`. Second call: `cache_read_input_tokens > 0`.
**Why human:** No live API spend in CI. Mock proves wiring and shape; actual cache behavior requires Anthropic infrastructure. Deferred to Phase 6 deploy-verify per VALIDATION.md.

---

## Summary

All 7 must-haves verified against codebase. Both test suites pass (31 worker + 50 db). Both packages build clean. Every cross-AI-review HIGH fix (D-13/D-15/D-16) is present and tested:

- `SCORING_MALFORMED_OUTPUT` is correctly `retryable:true` (Codex HIGH fix)
- `requeueJob` exists in DAL and worker routes correctly by attempts vs maxAttempts
- In-flight promises tracked in `Set<Promise>` with `.catch` (no unhandled rejection)
- All false-lease returns logged but not re-thrown
- `maxRetries: 0` on production Anthropic client

The `getSchemaTemplates` omission leaves `findings.schemaTemplate` always undefined. The rubric handles this gracefully (conservative scoring). Not a pipeline breakage.

---

## SHIP VERDICT

**SHIP WITH NOTES**

Phase 4 goal is achieved. Worker pipeline is correct, tested, and buildable. Ship to Phase 5 with one note:

> Add `getSchemaTemplates` call to `pipeline.ts` before or during Phase 5 if schema-template dimension scoring is required for production GEO scores. Current behavior scores that dimension conservatively (0–4 points) for all audits.

---

_Verified: 2026-06-02T18:30:00Z_
_Verifier: Claude (gsd-verifier) — independent, did not trust executor self-report_
