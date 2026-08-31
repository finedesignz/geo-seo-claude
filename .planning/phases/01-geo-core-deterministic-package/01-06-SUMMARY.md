---
phase: 01-geo-core-deterministic-package
plan: "06"
subsystem: "@geo/core"
tags: [phase-gate, esm, cjs, dual-package, zero-dep, barrel, CORE-06]
dependency_graph:
  requires: [01-00, 01-01, 01-02, 01-03, 01-04, 01-05]
  provides: [CORE-06, dual-ESM-CJS-consumability, public-surface-contract]
  affects: [Phase 2 HOW layer, Phase 5 Hono API, Phase 7 consumer wiring]
tech_stack:
  added: []
  patterns: [exports-map dual-package, injected-fetcher seam, zero-dep assertion script, no-network-import assertion]
key_files:
  created:
    - packages/core/src/__tests__/exports.test.ts
    - packages/core/scripts/verify-consumable.mjs
    - packages/core/scripts/verify-consumable.cjs
    - packages/core/scripts/verify-no-network-imports.mjs
    - packages/core/README.md
  modified:
    - packages/core/src/index.ts
    - packages/core/src/llmstxt.ts
    - packages/core/src/schema.ts
    - packages/core/src/__tests__/citability.test.ts
    - packages/core/src/__tests__/llmstxt.test.ts
    - packages/core/tsconfig.json
decisions:
  - "CitabilityResult removed from types.ts re-export in barrel — was duplicated from citability.ts re-export; canonical source is citability.ts"
  - "tsconfig.json gets types=[node] so test files resolve node: imports under tsc --noEmit without splitting src/test tsconfigs"
  - "No-network-import assertion uses regex on import statements (not variable names) to avoid false positives on fetchResult variable names"
metrics:
  duration: "~15 min"
  completed: "2026-06-02"
  tasks: 3
  files_modified: 10
---

# Phase 1 Plan 06: Public Surface Contract + Dual ESM/CJS Consumability Summary

**One-liner:** Zero-dep @geo/core proved consumable via both `import` and `require` with full 14-symbol public surface, 106-test suite green, and tsc --noEmit clean — CORE-06 phase gate satisfied.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Public-surface contract test + barrel completeness | 2075bc3 | exports.test.ts, index.ts |
| 2 | Dual ESM+CJS smoke + zero-dep assertion + README | 994d177 | verify-consumable.{mjs,cjs}, verify-no-network-imports.mjs, README.md, llmstxt.ts, schema.ts |
| 3 | Full-suite phase gate + tsc --noEmit clean | f01ab84 | tsconfig.json, citability.test.ts, llmstxt.test.ts |

## Phase Gate Results

| Gate | Result |
|------|--------|
| `bun run test -- --run` (full suite) | 7 files, 106 tests — PASS |
| `bun run build` (ESM + CJS + d.ts + d.cts) | PASS |
| `node scripts/verify-consumable.mjs` (ESM smoke) | PASS |
| `node scripts/verify-consumable.cjs` (CJS smoke) | PASS |
| Zero-dep assertion (package.json dependencies empty) | PASS |
| No-network-import assertion (8 source files scanned) | PASS |
| `tsc --noEmit` | PASS |

## Public Surface Verified

All 14 runtime exports asserted in exports.test.ts:

Functions: `checkRobots`, `generateLlmsTxt`, `validateLlmsTxt`, `getSchemaTemplates`, `validateStructuredData`, `computeCitabilityScore`, `scorePassage`, `detectRendering`, `normalizeUrl`

Objects/Arrays: `CITABILITY_WEIGHTS` (object, sums to 100), `AI_CRAWLERS` (array)

Types (compile-time only): `Fetcher`, `FetchResult`, `RobotsResult`, `LlmsTxtResult`, `SchemaTemplateResult`, `StructuredDataValidationResult`, `CitabilityResult`, `RenderingResult`, `CrawlData`, `PageData`, `SchemaType`, `CitabilityWeightKey`, `AiCrawler`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Duplicate CitabilityResult re-export in barrel**
- Found during: Task 1 build
- Issue: `CitabilityResult` exported from both `./types.js` and `./citability.js`, causing `TS2300 Duplicate identifier` in DTS build
- Fix: Removed from `./types.js` re-export block; canonical source is `./citability.js`
- Files modified: `packages/core/src/index.ts`
- Commit: 994d177

**2. [Rule 1 - Bug] TS2322 in llmstxt.ts — regex match groups possibly undefined**
- Found during: Task 2 DTS build
- Issue: `match[1]` and `match[2]` from regex result typed as `string | undefined` under `noUncheckedIndexedAccess`
- Fix: Added `?? ""` fallback on match[1] and match[2]
- Files modified: `packages/core/src/llmstxt.ts`
- Commit: 994d177

**3. [Rule 1 - Bug] TS2532 in schema.ts — match[1] possibly undefined**
- Found during: Task 2 DTS build
- Issue: Same noUncheckedIndexedAccess strictness on JSON-LD regex match
- Fix: Added `?? ""` fallback
- Files modified: `packages/core/src/schema.ts`
- Commit: f01ab84

**4. [Rule 2 - Missing critical] tsc --noEmit failing — no node types in tsconfig**
- Found during: Task 3 gate
- Issue: Test files use `node:fs`, `node:path`, `__dirname` but tsconfig had no `types: ["node"]`
- Fix: Added `"types": ["node"]` to tsconfig.json compilerOptions
- Files modified: `packages/core/tsconfig.json`
- Commit: f01ab84

**5. [Rule 1 - Bug] TS2578 unused @ts-expect-error in citability.test.ts**
- Found during: Task 3 gate — after adding node types TS now correctly types the cast
- Fix: Replaced `@ts-expect-error` + cast with direct bracket-notation assignment which TS allows after cast (frozen object throws at runtime regardless)
- Files modified: `packages/core/src/__tests__/citability.test.ts`
- Commit: f01ab84

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or file access introduced. The no-network-import assertion and zero-dep assertion scripts address T-01-X1 and T-01-X2 from the plan's threat register.

## Self-Check: PASSED

- exports.test.ts: present at packages/core/src/__tests__/exports.test.ts
- verify-consumable.mjs: present at packages/core/scripts/verify-consumable.mjs
- verify-consumable.cjs: present at packages/core/scripts/verify-consumable.cjs
- README.md: present at packages/core/README.md (>20 lines)
- Commits 2075bc3, 994d177, f01ab84: verified in git log
- 106 tests green, tsc --noEmit clean, all smokes exit 0
