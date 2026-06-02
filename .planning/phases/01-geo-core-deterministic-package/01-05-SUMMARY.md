---
phase: 01-geo-core-deterministic-package
plan: "05"
subsystem: "@geo/core"
tags: [rendering-detection, ssr, csr, hybrid, heuristic, python-port, bug-fix]
dependency_graph:
  requires: ["01-00 walking skeleton", "01-04 citability (RenderingResult stub in types.ts)"]
  provides: ["detectRendering(html)", "HYDRATION_MARKERS", "FRAMEWORK_ROOT_PATTERN", "CORE-05"]
  affects: ["packages/core/src/rendering.ts", "packages/core/src/types.ts", "packages/core/src/index.ts"]
tech_stack:
  added: []
  patterns: ["multi-signal weighted scoring", "input-length guard (ReDoS mitigation)", "result-accumulation error model"]
key_files:
  created:
    - packages/core/src/rendering.ts
    - packages/core/src/__tests__/rendering.test.ts
  modified:
    - packages/core/src/types.ts
    - packages/core/src/index.ts
decisions:
  - "RenderingResult.rendering uses lowercase ssr|csr|hybrid (not SSR|CSR|UNKNOWN from stub) — aligns with D-08 spec and plan"
  - "Roadmap success criterion says detectRendering(url) but D-08 specifies html-based (fetch injected); implemented html-based core; url+fetcher wrapper deferred to Phase 2 as noted"
  - "Word count alone does not gate CSR classification — fixes Python brittle single-boolean threshold"
  - "word-count signal always emitted to guarantee non-empty signals on plain SSR pages"
metrics:
  duration_minutes: 10
  completed_date: "2026-06-02"
  tasks_completed: 1
  files_changed: 4
---

# Phase 1 Plan 05: detectRendering (CORE-05) Summary

**One-liner:** Multi-signal SSR/CSR/hybrid classifier from raw HTML with framework root detection, hydration markers, script-weight scoring, and Python single-threshold bug fix.

## What Was Built

`detectRendering(html: string): RenderingResult` — pure function, zero deps, no throw.

**Signals scored:**
- `framework-root-div` (+3): `id=app|root|__next|__nuxt` present
- `hydration-marker:*:strong-csr` (+2 each): `v-cloak`, `x-data`, `__NUXT_DATA__`, `__NEXT_DATA__`
- `hydration-marker:*:ssr-confirmed` (-3): `data-server-rendered`
- `hydration-marker:*` (+1): `data-reactroot`, `ng-version`, `__svelte`
- `high-script-count` (+2) / `moderate-script-count` (+1): ≥3 / 2 script tags
- `low-root-text` (+2): framework root div inner text < 50 chars
- `high-word-count` (-1) / `low-word-count` (+1): >300 / <50 words
- `word-count:N` (neutral): emitted for all other pages to guarantee non-empty signals

**Classification thresholds:**
- csrScore ≥ 5 → `csr`
- csrScore ≤ 1 → `ssr`
- 2–4 → `hybrid`

**Security:** 5MB input guard before any regex (T-01-D1 ReDoS mitigation).

## Python Bug Fix

The Python `has_ssr_content` check required BOTH `root_text_length < 50` AND `word_count < 200`. This caused large-copy SPA shells (marketing landing pages rendered by React/Next) to be misclassified as SSR. The fix: framework root presence + hydration markers independently contribute CSR score; word count is a single weak signal that cannot override them.

## Wording Resolution

ROADMAP success criterion 5 says `detectRendering(url)` but D-08 (locked) specifies html-based with fetch injected. This plan implements the correct html-based core. A `url + fetcher` wrapper (which calls the fetcher, then calls `detectRendering(result.body)`) is a Phase 2 concern, NOT added here per `<environment_notes>`.

## Test Coverage (16 tests, all green)

| Group | Tests |
|-------|-------|
| CSR fixture classification | rendering=csr, signals, confidence, scriptCount |
| SSR fixture classification | rendering=ssr, signals, confidence |
| Python bug fix | large-copy SPA not "ssr", framework-root-div signal |
| Hydration markers | __NEXT_DATA__, v-cloak, data-server-rendered |
| Edge cases | empty, whitespace, determinism, oversized HTML |

Full suite: 100 tests passed (no regressions).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] SSR fixture produced empty signals array**
- **Found during:** RED→GREEN (test run)
- **Issue:** SSR fixture has no scripts, no framework root, no hydration markers — the word count branch only fired for >300 or <50 words; range 50-300 emitted nothing.
- **Fix:** Added `word-count:N` neutral signal for word counts 50-300 to guarantee non-empty signals on all non-trivial pages.
- **Files modified:** `packages/core/src/rendering.ts`
- **Commit:** 4cd1a4a (same task commit)

**2. [Rule 1 - Type] RenderingResult stub used uppercase SSR|CSR|UNKNOWN**
- **Found during:** Implementation
- **Issue:** types.ts stub had `"SSR" | "CSR" | "UNKNOWN"` — plan and D-08 specify lowercase `"ssr" | "csr" | "hybrid"`.
- **Fix:** Updated `RenderingResult` type to match spec. Also added `wordCount` and `scriptCount` fields per D-08.
- **Files modified:** `packages/core/src/types.ts`
- **Commit:** 4cd1a4a

**3. [Rule 1 - Path] Test fixture path was one level too deep**
- **Found during:** First test run
- **Issue:** Test used `../../../fixtures` but fixtures are at `../../fixtures` relative to `__tests__/`.
- **Fix:** Corrected path.
- **Files modified:** `packages/core/src/__tests__/rendering.test.ts`
- **Commit:** 4cd1a4a

## Known Stubs

None. `detectRendering` is fully wired and returns live classification from input HTML.

## Self-Check: PASSED

- `packages/core/src/rendering.ts` — FOUND
- `packages/core/src/__tests__/rendering.test.ts` — FOUND
- Commit `4cd1a4a` — FOUND (`git log --oneline -1`)
- `bun run --cwd packages/core test -- --run rendering` — 16/16 PASS
- Full suite — 100/100 PASS
