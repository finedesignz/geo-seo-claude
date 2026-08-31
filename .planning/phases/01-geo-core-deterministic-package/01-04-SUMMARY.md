---
phase: 01-geo-core-deterministic-package
plan: "04"
subsystem: "@geo/core"
tags: [citability, scoring, heuristics, tdd, redos-guard]
dependency_graph:
  requires: ["01-00"]
  provides: [computeCitabilityScore, scorePassage, CITABILITY_WEIGHTS, CitabilityWeightKey, PageData, PassageResult, CitabilityResult]
  affects: ["Phase 4 LLM prompt (CITABILITY_WEIGHTS single source of truth)"]
tech_stack:
  added: []
  patterns: [two-pass-html-regex-extraction, bounded-quantifiers-redos-guard, tdd-red-green]
key_files:
  created:
    - packages/core/src/citability.ts
    - packages/core/src/__tests__/citability.test.ts
  modified:
    - packages/core/src/index.ts
decisions:
  - "Aggregate page score = average of per-block scores, each category clamped to its weight max"
  - "Two-pass HTML: stripNoiseTags (regex replace) then tagPattern lazy walk — no cheerio (D-04)"
  - "All regex uses bounded/lazy quantifiers (max attribute length 500, max tag name 6 chars) to prevent ReDoS"
  - "Input size capped at MAX_HTML_BYTES (5MB) before any regex work"
  - "CITABILITY_WEIGHTS Object.freeze() at runtime to match `as const` read-only contract"
metrics:
  duration: "~8 minutes"
  completed: "2026-06-02"
  tasks_completed: 3
  files_modified: 3
---

# Phase 1 Plan 04: computeCitabilityScore + CITABILITY_WEIGHTS Summary

**One-liner:** Deterministic 0–100 citability scoring via five-category heuristics ported from Python, with `CITABILITY_WEIGHTS as const` (D-07) as the single source of truth for Phase 4's LLM prompt.

## What Was Built

`packages/core/src/citability.ts` exports:
- `CITABILITY_WEIGHTS` — frozen `as const` object `{answer_block_quality:30, self_containment:25, structural_readability:20, statistical_density:15, uniqueness_signals:10}` summing to exactly 100.
- `scorePassage(text, heading?)` — scores a single text passage across all five categories. Bounded/lazy regex throughout.
- `computeCitabilityScore({html, url?})` — two-pass HTML extraction (noise stripping → lazy tag walk), aggregates per-block scores, returns `{score, breakdown, blocksAnalyzed, errors}`. No throw on empty/oversized input.
- `CitabilityWeightKey`, `PageData`, `PassageResult`, `CitabilityResult` — all exported from barrel.

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED | `3dab46f` test(01-04): failing citability tests | PASS |
| GREEN | `de45329` feat(01-04): port citability scorer + weights | PASS |
| REFACTOR | N/A — no structural cleanup required | SKIPPED (optional) |

## Test Results

- 18 citability-specific tests pass.
- 84 total package tests pass (full suite green).

Key assertions covered:
- `CITABILITY_WEIGHTS` values sum to 100, has exactly 5 keys, is frozen.
- `scorePassage`: rich > vague ordering, per-category clamping, determinism, question-heading bonus, empty-text zero.
- `computeCitabilityScore`: 0–100 range, five breakdown keys, block count, empty/whitespace zero with no throw, noise-tag stripping, oversized HTML error, ReDoS pathological input completes < 1s.

## Security (Threat Model)

| Threat | Mitigation |
|--------|-----------|
| T-01-C1 DoS via adversarial HTML | Input guard at 5MB; all regex uses bounded/lazy quantifiers (max attr length 500, tag name ≤6 chars, lazy `[\s\S]*?` bodies). ReDoS test with pathological input passes in < 1ms. |
| T-01-C2 CITABILITY_WEIGHTS drift | `Object.freeze()` at runtime + `as const` TypeScript; sum-to-100 test asserts integrity. |

## Deviations from Plan

None — plan executed exactly as written. REFACTOR commit omitted (helpers already well-structured in GREEN; no behavioral change warranted a separate commit).

## Known Stubs

None — all scoring logic is wired and deterministic.

## Self-Check

- `packages/core/src/citability.ts` — FOUND
- `packages/core/src/__tests__/citability.test.ts` — FOUND
- `packages/core/src/index.ts` (modified) — FOUND
- Commit `3dab46f` RED — FOUND
- Commit `de45329` GREEN — FOUND
- Full test suite 84/84 — PASS

## Self-Check: PASSED
