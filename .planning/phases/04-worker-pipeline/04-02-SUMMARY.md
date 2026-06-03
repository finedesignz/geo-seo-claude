---
phase: 04-worker-pipeline
plan: "02"
subsystem: worker
tags: [pipeline, worker-loop, concurrency, lease-heartbeat, requeueJob, scoring]
dependency_graph:
  requires: ["04-00", "04-01", "03-00", "03-01"]
  provides: ["runAudit", "runWorker", "requeueJob"]
  affects: ["packages/worker", "packages/db"]
tech_stack:
  added: []
  patterns:
    - "Lease-fenced requeueJob (running→queued, retryable path)"
    - "In-flight Set<Promise<void>> with .catch+.finally (no unhandledRejection)"
    - "Heartbeat renewLease every leaseTtlSecs/2; false→AbortController.abort()"
    - "Injectable clock/sleep seam for deterministic fake-timer tests"
    - "SIGTERM/SIGINT cleanup in finally (no listener accumulation)"
key_files:
  created:
    - packages/worker/src/pipeline.ts
    - packages/worker/src/worker.ts
    - packages/worker/src/__tests__/pipeline.test.ts
    - packages/worker/src/__tests__/worker.test.ts
    - packages/db/src/__tests__/requeue.test.ts
  modified:
    - packages/db/src/dal.ts
    - packages/worker/src/main.ts
    - packages/worker/src/index.ts
    - packages/worker/src/types.ts
decisions:
  - "requeueJob committed to @geo/db as a separate first commit (D-15 dep ordering)"
  - "schemaTemplate not populated in pipeline (getSchemaTemplates takes a SchemaType, not HTML — not applicable to per-URL pipeline without type inference)"
  - "llmsTxt absent/blocked leaves findings.llmsTxt undefined (scorer treats as conservative)"
  - "Heartbeat callback uses .then() not async to satisfy setInterval's () => void constraint"
  - "main.ts wraps top-level await in main() for CJS build compat"
metrics:
  duration: "~25 minutes"
  completed: "2026-06-02"
  tasks_completed: 4
  files_created: 5
  files_modified: 4
---

# Phase 4 Plan 02: Pipeline + Worker Loop + Main Summary

**One-liner:** Lease-fenced audit pipeline with bounded-concurrency worker loop, requeueJob retry path, heartbeat abort, reclaim sweep, and SIGTERM graceful drain.

## What Was Built

### Step A: `requeueJob` in `@geo/db` (D-15)
`packages/db/src/dal.ts` — `requeueJob(id, leaseToken, errorCode): Promise<boolean>`. SQL: `UPDATE audits SET status='queued', error_code=$3, lease_token=NULL, locked_at=NULL, lease_expires_at=NULL WHERE id=$1 AND lease_token=$2::uuid AND status='running' RETURNING id`. Does not touch `attempts` (already incremented at claim). Fenced by lease token — wrong token returns false. Added to `AuditDal` interface.

### Task 1: `packages/worker/src/pipeline.ts`
`runAudit(job, deps)`: fetch → `checkRobots` + `detectRendering` + `computeCitabilityScore` + `validateStructuredData` + `validateLlmsTxt` → `scorer.score` → `completeJob` (success only). Error routing: fetch error → `failJob` (no scorer call); `ScoringError` → `requeueJob` if `attempts < maxAttempts` else `failJob`; `completeJob` unreachable from any catch branch. Heartbeat via injectable `setInt`; `clearInt` in finally.

### Task 2: `packages/worker/src/worker.ts`
`runWorker(opts)`: `Set<Promise<void>>` in-flight tracking with `.catch(logErr).finally(set.delete)`. Poll loop: `inFlight.size < concurrency` → claim → runAudit (not awaited). `scheduleInterval(reclaimExpired, reclaimIntervalMs)`. SIGTERM/SIGINT → `shuttingDown=true` → drain loop (max `shutdownGraceMs`) → `cancelInterval` + `process.off` in finally.

### Task 3: `packages/worker/src/main.ts`
`assertEnv()` called synchronously before any async. `new Anthropic({ maxRetries: 0 })` (mandatory — SDK must not absorb 429/5xx internally). `getDefaultDal()` + `createSafeFetcher()`. All env vars parsed with documented defaults.

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| packages/db (incl. requeue.test.ts) | 50 pass, 1 skipped | GREEN |
| packages/worker pipeline.test.ts | 6 pass | GREEN |
| packages/worker worker.test.ts | 5 pass | GREEN |
| packages/worker (all) | 31 pass | GREEN |

**WORK-02a:** done row, numeric score 72, findings non-null — PASS  
**WORK-02b:** SSRF fetch → failed + SSRF_BLOCKED_IP, scorer call-count 0 — PASS  
**WORK-02d/e:** ScoringError routes requeueJob vs failJob by attempts — PASS  
**WORK-02f:** completeJob→false logged, no throw — PASS  
**WORK-03:** concurrency cap at 2, 3rd claim after slot freed — PASS  
**WORK-04b:** reclaimExpired on schedule (fake timers) — PASS  
**WORK-04c:** SIGTERM drains, resolves — PASS  
**WORK-04f:** rejecting pipeline → no unhandledRejection, slot freed — PASS  
**WORK-04g:** SIGTERM listener count returns to baseline — PASS  

## Deviations from Plan

**1. [Rule 1 - Bug] `getSchemaTemplates` API mismatch**
- Found during: Task 1 implementation
- Issue: `getSchemaTemplates(type: SchemaType)` generates a template by type; it does not analyze HTML. There is no `validateSchemaTemplates(html)` equivalent.
- Fix: Omit `findings.schemaTemplate` from pipeline (optional in `FindingsShape`). The scorer sees `undefined` and scores conservatively for that dimension. Tracked in deferred items.
- Files: packages/worker/src/pipeline.ts

**2. [Rule 3 - Blocking] Top-level await not supported in CJS**
- Found during: Task 3 build
- Issue: tsup builds both ESM + CJS; CJS doesn't support top-level await.
- Fix: Wrapped in `async function main(){}; main().catch(...)`.
- Files: packages/worker/src/main.ts

**3. [Rule 3 - Blocking] `setInterval` return type differs across environments**
- Found during: Task 2 build (DTS phase)
- Issue: Node.js returns `NodeJS.Timeout`; fake timers return `number`; they're incompatible.
- Fix: Changed `WorkerOptions.scheduleInterval`/`cancelInterval` and `PipelineDeps.clock` to use `any` type annotations with eslint-disable comments.
- Files: packages/worker/src/types.ts, packages/worker/src/pipeline.ts, packages/worker/src/worker.ts

**4. [Rule 1 - Bug] `setInterval` callback typed `() => void` rejects `async () => void`**
- Found during: Task 1 build (DTS phase)
- Issue: Passing an `async` function to `setInterval` callback type causes TS error.
- Fix: Converted heartbeat to use `.then()` chaining inside a sync callback.
- Files: packages/worker/src/pipeline.ts

## Known Stubs

None — all pipeline paths functional. `schemaTemplate` omitted (see deviation #1); the scorer handles `undefined` gracefully.

## Threat Flags

None beyond those documented in the plan's threat model (T-04-SSRF, T-04-FENCE, T-04-PARTIAL, T-04-DOS, T-04-INFO — all mitigated as designed).

## Self-Check: PASSED

- packages/worker/src/pipeline.ts: exists
- packages/worker/src/worker.ts: exists
- packages/worker/src/main.ts: updated
- packages/worker/src/__tests__/pipeline.test.ts: exists
- packages/worker/src/__tests__/worker.test.ts: exists
- packages/db/src/__tests__/requeue.test.ts: exists
- Commit 7ceffd1: requeueJob @geo/db — confirmed
- Commit 6da178f: pipeline + worker + main — confirmed
- All test suites green
- Build clean (ESM + CJS + DTS)
