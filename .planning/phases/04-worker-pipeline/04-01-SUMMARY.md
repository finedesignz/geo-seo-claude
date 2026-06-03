---
phase: "04-worker-pipeline"
plan: "01"
subsystem: "@geo/worker scorer slice"
tags: ["anthropic-sdk", "forced-tool-use", "prompt-cache", "zod", "retryable-errors"]
dependency_graph:
  requires: ["packages/worker/src/types.ts (AnthropicMessagesClient seam)", "packages/db (FindingsShape)"]
  provides: ["createScorer", "ScoringError", "GeoScoreSchema", "GEO_SCORING_RUBRIC", "classifyScoringError"]
  affects: ["packages/worker/src/index.ts"]
tech_stack:
  added: ["@anthropic-ai/sdk forced tool-use", "zod GeoScoreSchema"]
  patterns: ["AbortController timeout", "instanceof error classification", "prompt caching via cache_control:ephemeral"]
key_files:
  created:
    - packages/worker/src/scorer.ts
    - packages/worker/src/__tests__/scorer.test.ts
  modified:
    - packages/worker/src/index.ts
decisions:
  - "All 4 ScoringError codes are retryable:true (ROADMAP success criterion #4 — malformed output is retryable, MAX_ATTEMPTS bounds it)"
  - "GEO_SCORING_RUBRIC is a genuine 2500+ token scoring methodology — not padded, written to be stable/static for prompt caching"
  - "maxRetries:0 requirement documented in scorer header comment for wave 2 main.ts"
  - "New Headers() required for SDK error constructors (RateLimitError/InternalServerError) in tests"
metrics:
  duration: "~15 min"
  completed: "2026-06-02"
  tasks: 2
  files: 3
---

# Phase 4 Plan 01: Scorer Slice Summary

**One-liner:** Forced-tool-use Anthropic scorer with zod validation, AbortController timeout, prompt cache wiring, and exhaustive retryable ScoringError classification — all under an injected mockable client.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | scorer.ts — ScoringError, GeoScoreSchema, GEO_SCORING_RUBRIC, createScorer | 100cfe0 | scorer.ts, index.ts |
| 2 | scorer.test.ts — SCORE-01..04 with injected fake client | 100cfe0 | scorer.test.ts |

## What Was Built

- `ScoringError` — extends Error with `code` union (4 values) and `retryable: boolean`; `name='ScoringError'`. All four codes are `retryable: true` per ROADMAP success criterion #4.
- `GeoScoreSchema` — zod: `score = z.number().int().min(0).max(100)`, `findings = z.record(z.string(), z.unknown())`.
- `GEO_SCORING_RUBRIC` — ~2500 token static string covering the full GEO scoring methodology across 6 dimensions (crawlability, llmsTxt, schema templates, structured data, citability, rendering) with per-dimension rubric tables. Stable/static — safe as cached prefix.
- `RECORD_GEO_SCORE_TOOL` — Anthropic tool definition with `input_schema` matching the zod contract.
- `classifyScoringError` — instanceof chain: `APIConnectionTimeoutError`→TIMEOUT, `APIUserAbortError`→TIMEOUT, `APIConnectionError`→API_ERROR, `RateLimitError`→RATE_LIMITED, `InternalServerError`→API_ERROR, `APIError`→API_ERROR(status>=500), fallback→API_ERROR(false).
- `createScorer(client, {model, timeoutMs})` — returns `score(findings, externalSignal?)` which: builds AbortController + setTimeout, links externalSignal, makes ONE `messages.create` with forced tool_choice, cache_control:ephemeral on system block, JSON.stringify(findings) as user content, extracts tool_use block, zod-validates, returns `{score, findings, usage}`. Any error → classifyScoringError → rethrow ScoringError.

## Test Results

20 tests, 20 passed, 0 failed.

Coverage:
- SCORE-01: messages.create called exactly once; tool_choice forced shape; score===72 returned
- SCORE-02: messages[0].content===JSON.stringify(findings); no HTML in dynamic input; system[0].text===GEO_SCORING_RUBRIC
- SCORE-03: cache_control:{type:'ephemeral'} on system[0]; cache_creation_input_tokens surfaced (first call); cache_read_input_tokens surfaced (cache hit call)
- SCORE-04: APIConnectionTimeoutError→SCORING_TIMEOUT(retryable:true); APIUserAbortError→SCORING_TIMEOUT(retryable:true); RateLimitError→SCORING_RATE_LIMITED(retryable:true); InternalServerError→SCORING_API_ERROR(retryable:true); missing tool_use→SCORING_MALFORMED_OUTPUT(retryable:true); score:150→SCORING_MALFORMED_OUTPUT(retryable:true); no partial score on any error path

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] SDK error constructors require `new Headers()` not `{}`**
- **Found during:** Task 2 test run
- **Issue:** `RateLimitError`/`InternalServerError` constructors call `headers?.get()` — passing `{}` threw `TypeError: headers?.get is not a function`
- **Fix:** Changed test constructors to pass `new Headers()` (global Web API, available in Bun/vitest)
- **Files modified:** scorer.test.ts
- **Commit:** 100cfe0 (same commit)

**2. [Rule 1 - Bug] RESEARCH.md showed `retryable: false` for malformed output in Pattern 1 code example**
- **Issue:** The code example in RESEARCH.md Pattern 1 had `ScoringError('SCORING_MALFORMED_OUTPUT', false)` but PLAN.md and CONTEXT.md D-13 both specify all codes are `retryable: true` (the cross-AI review fix). Honored the plan over the example.
- **Fix:** Both missing-tool_use and zod-invalid throw `ScoringError('SCORING_MALFORMED_OUTPUT', true)`.
- **Commit:** 100cfe0

## Threat Surface Scan

No new threat surface introduced — scorer.ts has no network endpoints, no file access. The T-04-LLM mitigation (zod GeoScoreSchema.safeParse rejects invalid tool_use.input → SCORING_MALFORMED_OUTPUT retryable) is implemented and tested.

## Self-Check: PASSED

- packages/worker/src/scorer.ts: EXISTS
- packages/worker/src/__tests__/scorer.test.ts: EXISTS
- packages/worker/src/index.ts: MODIFIED (wave 1 exports uncommented)
- Commit 100cfe0: EXISTS (git log confirms)
- Build: green (tsup dual ESM+CJS+d.ts)
- Tests: 20/20 green
