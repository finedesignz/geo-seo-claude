---
phase: 01-geo-core-deterministic-package
plan: "02"
subsystem: "@geo/core"
tags: [llmstxt, generator, validator, deterministic, tdd]
dependency_graph:
  requires: [01-00]
  provides: [CORE-02]
  affects: [packages/core/src/index.ts]
tech_stack:
  added: []
  patterns: [stdlib-string-building, line-split-scanning, tdd-red-green]
key_files:
  created:
    - packages/core/src/llmstxt.ts
    - packages/core/src/__tests__/llmstxt.test.ts
  modified:
    - packages/core/src/index.ts
decisions:
  - "Only `# Title` is mandatory (A4); missing description/sections/links → warnings, not errors"
  - "escapeLinkTitle escapes [ and ] in page titles to prevent Markdown link corruption"
  - "Default section name is 'Pages' for pages with no section field"
  - "validateLlmsTxt uses per-line scanning (T-01-L1: no full-doc backtracking regex)"
metrics:
  duration: "~5 min"
  completed: "2026-06-02"
  tasks: 1
  files: 3
---

# Phase 1 Plan 02: generateLlmsTxt + validateLlmsTxt (CORE-02) Summary

**One-liner:** Deterministic llms.txt generation from typed CrawlData with Markdown-safe escaping, and a line-scan validator separating mandatory title errors from recommended-element warnings.

## What Was Built

- `generateLlmsTxt(crawlData: CrawlData): string` — emits spec-shaped llms.txt: `# Title`, `> description`, `## Section` headings, `- [Title](url): desc` entries, optional `## Contact`. Preserves first-seen section order; escapes `[` and `]` in titles. Zero deps, pure string building.
- `validateLlmsTxt(text: string): LlmsTxtValidationResult` — returns `{ valid, hasTitle, hasDescription, sectionCount, linkCount, errors[], warnings[] }`. `valid` = title present only (A4). Mandatory miss → `errors`; recommendations → `warnings`. Per-line regex, no backtracking.
- `CrawlData`, `CrawlPage`, `LlmsTxtValidationResult` types exported from barrel.
- 17 new vitest tests; full suite 39/39 green.

## Deviations from Plan

None — plan executed exactly as written.

## TDD Gate Compliance

- RED: `test(01-02)` commit — 17 tests importing missing module (import error = red).
- GREEN: `feat(01-02)` commit — all 17 pass.
- No REFACTOR phase needed.

## Known Stubs

None.

## Self-Check: PASSED

- `packages/core/src/llmstxt.ts` — exists.
- `packages/core/src/__tests__/llmstxt.test.ts` — exists.
- `packages/core/src/index.ts` — exports `generateLlmsTxt`, `validateLlmsTxt`, `CrawlData`.
- Commit `000369f` — verified in git log.
- `bun run test --run` → 39/39 green.
