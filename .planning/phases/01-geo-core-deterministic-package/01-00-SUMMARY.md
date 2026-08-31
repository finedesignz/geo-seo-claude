---
phase: 01-geo-core-deterministic-package
plan: "00"
subsystem: "@geo/core"
tags: [walking-skeleton, bun-workspace, tsup, vitest, type-seam, fetch-injection]
dependency_graph:
  requires: []
  provides: ["@geo/core workspace package", "FetchResult/Fetcher seam", "AI_CRAWLERS", "normalizeUrl", "result-type stubs", "Wave 1 fixtures"]
  affects: ["packages/core", "package.json"]
tech_stack:
  added: ["tsup@8.5.1", "vitest@4.1.8", "typescript@6.0.3", "@types/node@25.9.1"]
  patterns: ["Bun workspaces", "dual ESM+CJS build", "inject-don't-network", "result-accumulation error model"]
key_files:
  created:
    - package.json
    - packages/core/package.json
    - packages/core/tsconfig.json
    - packages/core/tsup.config.ts
    - packages/core/vitest.config.ts
    - packages/core/src/types.ts
    - packages/core/src/url.ts
    - packages/core/src/index.ts
    - packages/core/src/__tests__/skeleton.test.ts
    - packages/core/fixtures/ssr-page.html
    - packages/core/fixtures/csr-page.html
    - packages/core/fixtures/schema-rich.html
    - packages/core/fixtures/schema-none.html
    - packages/core/fixtures/robots-sample.txt
    - packages/core/fixtures/llmstxt-valid.txt
  modified: []
decisions:
  - "FetchResult.headers lowercase-keyed per HTTP/2 convention; normalization is caller responsibility"
  - "normalizeUrl uses stdlib URL constructor only (no node: imports) — seeds Pitfall-4 URL-handling pattern"
  - "AI_CRAWLERS ported from scripts/fetch_page.py as readonly const tuple"
  - "tsconfig ignoreDeprecations:6.0 required for tsup DTS build with moduleResolution:bundler on TS 6.0.3"
  - "dist/ gitignored — build artifacts not committed, verified via bun run build"
metrics:
  duration: "~15 minutes"
  completed: "2026-06-02"
  tasks_completed: 2
  files_created: 15
  commits: 4
requirements_shipped: [CORE-06]
---

# Phase 1 Plan 0: Walking Skeleton Summary

**One-liner:** Bun workspace + tsup dual ESM+CJS build + vitest + FetchResult/Fetcher fetch-injection seam with normalizeUrl and AI_CRAWLERS exercised end-to-end through the public barrel.

## What Was Built

The `@geo/core` walking skeleton — a thin, compiling, testable foundation every later Wave 1–7 plan builds on:

1. **Bun workspace** — root `package.json` with `workspaces: ["packages/*"]`; `bun install` links `@geo/core` as a local workspace package.
2. **@geo/core manifest** — `packages/core/package.json`: name `@geo/core`, version `0.1.0`, `"type": "module"`, exports map (types-first in each condition), zero runtime dependencies, dev deps: tsup/vitest/typescript/@types/node.
3. **TypeScript config** — `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: bundler`, `ignoreDeprecations: "6.0"` (required for TS 6.0.3 + tsup DTS).
4. **Dual build** — tsup emits `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts` + `dist/index.d.cts` (types). CJS require smoke: `AI_CRAWLERS.includes('GPTBot')` and `normalizeUrl('https://example.com').errors.length === 0` both pass.
5. **Type seam (D-05)** — `FetchResult` + `Fetcher` defined in `src/types.ts`. `FetchResult.headers` is lowercase-keyed. Zero network imports in `src/`.
6. **Result-type stubs (D-06)** — `RobotsResult`, `LlmsTxtResult`, `SchemaTemplateResult`, `StructuredDataValidationResult`, `CitabilityResult`, `RenderingResult` — all with `errors: string[]`; exported from barrel; Wave 1 fills fields.
7. **AI_CRAWLERS** — ported from `scripts/fetch_page.py`: GPTBot, ClaudeBot, PerplexityBot, GoogleBot, BingBot as `readonly` const tuple.
8. **normalizeUrl** — stdlib `URL` only, no `node:` imports; returns `{ url, errors }`, never throws.
9. **Test suite** — 4/4 passing in vitest via `bun run test -- --run`.
10. **Wave 1 fixtures** — 6 fixture files committed: ssr-page.html, csr-page.html, schema-rich.html, schema-none.html, robots-sample.txt, llmstxt-valid.txt.

## Verification Checklist

- [x] `bun install` — 174 packages, workspace linked, no errors
- [x] `bun run --cwd packages/core test -- --run` — 4/4 green
- [x] `bun run --cwd packages/core build` — ESM + CJS + .d.ts/.d.cts all emit
- [x] CJS require smoke — `AI_CRAWLERS` and `normalizeUrl` resolve correctly
- [x] No `node:` imports in `packages/core/src/`
- [x] Zero runtime dependencies in `packages/core/package.json`
- [x] All 6 Wave 1 fixtures committed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript 6.0.3 `baseUrl` deprecation error in tsup DTS build**
- **Found during:** Task 2 GREEN phase, first build attempt
- **Issue:** tsup DTS build with `moduleResolution: bundler` implicitly sets `baseUrl`, which TS 6.0.3 treats as a deprecation error (TS5101), halting the DTS stage.
- **Fix:** Added `"ignoreDeprecations": "6.0"` to `packages/core/tsconfig.json` (the official migration path per https://aka.ms/ts6).
- **Files modified:** `packages/core/tsconfig.json`
- **Commit:** f75c261

## Threat Flags

None. `@geo/core` has no network surface (zero I/O by design, D-05). All dev dep supply chain risks pre-cleared in RESEARCH Package Legitimacy Audit (T-01-SC: mitigated).

## Known Stubs

The following result types are intentional stubs — exported from the barrel now so no downstream import ever breaks, but fields are minimal pending Wave 1 implementation:

| Stub | File | Wave 1 Plan |
|------|------|-------------|
| `RobotsResult` | `src/types.ts` | Plan 01 (robots.txt parser) |
| `LlmsTxtResult` | `src/types.ts` | Plan 02 (llms.txt generator) |
| `SchemaTemplateResult` | `src/types.ts` | Plan 03 (schema templates) |
| `StructuredDataValidationResult` | `src/types.ts` | Plan 03 (schema validator) |
| `CitabilityResult` | `src/types.ts` | Plan 04 (citability scorer) |
| `RenderingResult` | `src/types.ts` | Plan 05 (SSR/CSR detection) |

These stubs are intentional per SKELETON.md "Deferred to Later Slices". They do not block Plan 00's goal (walking skeleton proven end-to-end).

## Self-Check: PASSED

All source files present. All commits verified (4a4f7d9, 18a9611, f75c261, 19bbfb1). Build and tests green at time of writing.
