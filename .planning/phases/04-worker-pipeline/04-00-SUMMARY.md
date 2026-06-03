---
phase: 04-worker-pipeline
plan: "00"
subsystem: worker
tags: [scaffold, types, env-guard, injection-seam]
dependency_graph:
  requires: [03-01]
  provides: [packages/worker barrel, assertEnv, AnthropicMessagesClient, WorkerOptions]
  affects: [04-01, 04-02]
tech_stack:
  added: ["@anthropic-ai/sdk@0.100.1", "zod@3.25.51"]
  patterns: [tsup-dual-build, vitest, fail-fast-env-guard, constructor-injection]
key_files:
  created:
    - packages/worker/package.json
    - packages/worker/tsconfig.json
    - packages/worker/tsup.config.ts
    - packages/worker/vitest.config.ts
    - packages/worker/src/index.ts
    - packages/worker/src/main.ts
    - packages/worker/src/env.ts
    - packages/worker/src/types.ts
    - packages/worker/src/__tests__/scaffold.test.ts
  modified:
    - bun.lock
decisions:
  - "@geo/worker mirrors @geo/db conventions exactly (tsup dual ESM+CJS+d.ts, vitest, ESM .js import extensions)"
  - "WorkerOptions includes all injectable time primitives (now/sleep/scheduleInterval/cancelInterval) per D-16"
  - "main.ts created as empty placeholder so tsup bin entry resolves; wave 2 fills it in"
metrics:
  duration: "~10 minutes"
  completed: "2026-06-02"
  tasks_completed: 2
  files_created: 9
---

# Phase 04 Plan 00: @geo/worker Scaffold Summary

@geo/worker workspace package with tsup dual build, fail-fast env guard, and injectable AnthropicMessagesClient + WorkerOptions seams — mirrors @geo/db conventions exactly.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Package scaffold (package.json, tsup, vitest, barrel) | ead45ba | package.json, tsup.config.ts, vitest.config.ts, tsconfig.json, src/index.ts, src/main.ts |
| 2 | Env guard + injection-seam types + conformance test | ead45ba | src/env.ts, src/types.ts, src/__tests__/scaffold.test.ts |

## Verification

- `bun run --cwd packages/worker build` — PASS (dist/index.js, dist/index.cjs, dist/index.d.ts emitted)
- `bun run --cwd packages/worker test -- --run` — PASS (4/4 tests)
- tsc conformance: WorkerOptions references AuditDal (@geo/db) and Fetcher (@geo/core), compile-time verified in scaffold.test.ts

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

- `src/main.ts`: empty placeholder (bin entry). Wave 2 fills in `assertEnv()`, argv parsing, `runWorker(opts)`.
- `src/index.ts`: `runWorker` and `ScoringError` exports commented with `// wave 1/2` markers.

These stubs are intentional — the plan explicitly defers business logic to waves 1 and 2.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundaries introduced. `assertEnv()` implements T-04-INFO mitigation (env-only read, fail-fast, no value echo in error messages). No threat flags.

## Self-Check: PASSED

- packages/worker/src/env.ts — FOUND
- packages/worker/src/types.ts — FOUND
- packages/worker/src/__tests__/scaffold.test.ts — FOUND
- packages/worker/dist/index.js — FOUND (post-build)
- Commit ead45ba — FOUND
