---
phase: 02-ssrf-fetch-hardening
plan: "03"
subsystem: packages/fetch
tags: [security, ssrf, decompression-bomb, size-cap, fetcher-conformance, SEC-04, SEC-05]
requirements: [SEC-04, SEC-05]
dependency_graph:
  requires: ["02-02"]
  provides: ["packages/fetch — fully hardened, dual build, phase gate"]
  affects: ["packages/core (Fetcher consumer)"]
tech_stack:
  added: ["node:zlib (makeByteCounter, buildDecompressChain)", "tsconfig.check.json"]
  patterns: ["Transform stream byte-counting", "decompression pipeline", "Content-Length early reject"]
key_files:
  created:
    - packages/fetch/src/decompression.ts
    - packages/fetch/src/__tests__/decompression.test.ts
    - packages/fetch/src/__tests__/size.test.ts
    - packages/fetch/src/__tests__/exports.test.ts
    - packages/fetch/tsconfig.check.json
    - packages/fetch/README.md
  modified:
    - packages/fetch/src/safe-fetcher.ts
decisions:
  - "makeByteCounter placed after final decompressor so cap is on decompressed bytes (bomb defense)"
  - "identity bodies get a raw-wire RESPONSE_TOO_LARGE counter (no decompressors in chain)"
  - "stacked encoding cap is 2; enforced synchronously in buildDecompressChain before streaming"
  - "tsconfig.check.json created (rootDir='.') so tsc --noEmit can include test helpers outside src/"
  - "SEC-05 job-level failed mapping is consumer responsibility (Phase 4)"
metrics:
  duration: "~15 minutes"
  completed: "2026-06-02T20:17:11Z"
  tasks_completed: 2
  files_created: 6
  files_modified: 1
---

# Phase 02 Plan 03: Size Cap + Decompression-Bomb Defense + Fetcher-Conformance Gate Summary

Two-counter DoS defense (raw wire bytes + decompressed bytes), stacked-encoding cap, and phase gate proving complete `@geo/fetch` public surface with `@geo/core` Fetcher type conformance.

## Tasks Completed

| Task | Name | Commit |
|---|---|---|
| 1 | decompression.ts — byte-counting decompress pipeline | 24e8e4d |
| 2 | Wire size cap + decompression; exports/Fetcher-conformance gate | 9893c26 |

## What Was Built

**Task 1 — decompression.ts:**
- `makeByteCounter(maxBytes, code)`: passthrough Transform that errors with `.code` past cap.
- `buildDecompressChain(contentEncoding, maxBytes)`: parses comma-separated encodings, rejects >2 layers (`DECOMPRESSION_BOMB`), unknown encodings (`FETCH_ERROR`), maps gzip/x-gzip/deflate/br to node:zlib. Appends counter AFTER final decompressor so cap is on decompressed bytes.
- 12 unit tests: identity cap, gzip bomb, 3-layer stacking, aliases, double-layer, unknown, RFC-correct reverse-order decode.

**Task 2 — safe-fetcher.ts wiring:**
- Content-Length early reject before body read (`RESPONSE_TOO_LARGE`).
- Identity bodies: raw-wire `makeByteCounter` (RESPONSE_TOO_LARGE).
- Compressed bodies: `buildDecompressChain` pipeline with post-decompressor bomb counter.
- `readBodyBounded` helper streams undici body async-iterable through transforms.
- `size.test.ts`: 5 integration tests via MockAgent loopback (Content-Length, chunked, bomb, stacked, happy path).
- `exports.test.ts`: phase gate — createSafeFetcher exported, 10 FetchErrorCode values, runtime FetchResult shape, compile-time `const f: Fetcher = createSafeFetcher()` assertion.

## Test Results

- `packages/fetch` suite: **107 passed, 7 todo** (8 test files)
- `packages/core` suite: **106 passed** (7 test files)
- `bunx tsc --noEmit -p tsconfig.check.json`: exit 0
- Build: dist/index.js (ESM), dist/index.cjs (CJS), dist/index.d.ts all emitted

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocker] tsconfig rootDir mismatch for tsc --noEmit**
- Found during: Task 2 (verification)
- Issue: `tsconfig.json` has `rootDir: ./src` (correct for build) but test files import from `../test/helpers` outside src, causing tsc error TS6059.
- Fix: Created `tsconfig.check.json` extending the base with `rootDir: "."` and `include: ["src/**/*.ts", "test/**/*.ts"]`. Build tsconfig unchanged.
- Files modified: packages/fetch/tsconfig.check.json (new)

**2. [Rule 3 - Blocker] createStaticResolver signature mismatch in size.test.ts**
- Found during: Task 2 RED run
- Issue: Called `createStaticResolver({ hostname: [ip] })` but it takes `string[]`, not a map.
- Fix: Switched to `createMockResolver([[ip], [ip], ...])` with enough entries for each test.
- Files modified: packages/fetch/src/__tests__/size.test.ts

## Known Stubs

None.

## Threat Flags

None — all surfaces are within the plan's threat model (T-02-14 through T-02-17).

## Self-Check: PASSED

- packages/fetch/src/decompression.ts — FOUND
- packages/fetch/src/__tests__/decompression.test.ts — FOUND
- packages/fetch/src/__tests__/size.test.ts — FOUND
- packages/fetch/src/__tests__/exports.test.ts — FOUND
- packages/fetch/tsconfig.check.json — FOUND
- packages/fetch/README.md — FOUND
- Commit 24e8e4d — FOUND
- Commit 9893c26 — FOUND
