---
phase: 4
slug: worker-pipeline
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-02
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Environment constraint

No live Anthropic API spend in CI. The `@anthropic-ai/sdk` client is the ONLY external dependency mocked — via a **constructor-injected** `AnthropicMessagesClient` interface (never `vi.mock('@anthropic-ai/sdk')` — hoisting is fragile). Everything else runs for real: job state against **PGlite** (reuse the Phase 3 harness), deterministic `@geo/core` checks against **Phase 2 loopback HTTP fixtures**, heartbeat/reclaim/concurrency driven by **`vi.useFakeTimers()`** + injected clock. The optional live-API scoring smoke test (real key) is deferred to Phase 6 deploy-verify.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (mirror `packages/db`) |
| **Config file** | `packages/worker/vitest.config.ts` (Wave 0 installs) |
| **Quick run command** | `bun run --cwd packages/worker test -- --run` |
| **Full suite command** | `bun run --cwd packages/worker test -- --run` |
| **Estimated runtime** | ~15 seconds (PGlite + loopback + mock) |

---

## Sampling Rate

- **After every task commit:** `bun run --cwd packages/worker test -- --run`
- **After every plan wave:** full suite + `bun run --cwd packages/worker build`
- **Before verify:** full suite green; worker types conform to `@geo/db` `AuditDal` + `@geo/core` `Fetcher` (tsc clean)
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Wave | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|-------------|-----------------|-----------|-------------------|-------------|--------|
| 4-W0 | 0 | infra | package scaffold + deps + Fetcher/AuditDal type conformance | infra | `bun run --cwd packages/worker test -- --run` | ❌ W0 | ⬜ pending |
| 4-SCORE-01 | 1 | SCORE-01 | exactly one `messages.create` per job; forced tool-use `tool_choice:{type:'tool',name:'record_geo_score'}`; `tool_use` block extracted + zod-validated | unit (mock Anthropic) | `vitest run scorer` | ❌ W0 | ⬜ pending |
| 4-SCORE-02 | 1 | SCORE-02 | dynamic input = serialized `@geo/core` findings (NOT raw HTML); static rubric lives in cached system block | unit (mock Anthropic) | `vitest run scorer` | ❌ W0 | ⬜ pending |
| 4-SCORE-03 | 1 | SCORE-03 | `cache_control:{type:'ephemeral'}` present on system block; test asserts `usage.cache_creation_input_tokens` / `cache_read_input_tokens` present in response | unit (mock Anthropic) | `vitest run scorer` | ❌ W0 | ⬜ pending |
| 4-SCORE-04 | 1 | SCORE-04 | timeout→`SCORING_TIMEOUT`(retryable), 429→`SCORING_RATE_LIMITED`(retryable), 529/5xx→`SCORING_API_ERROR`(retryable), missing tool_use / zod-invalid→`SCORING_MALFORMED_OUTPUT`(not retryable); **`completeJob` call count == 0 on every error path** | unit (mock Anthropic) | `vitest run scorer` | ❌ W0 | ⬜ pending |
| 4-WORK-02a | 2 | WORK-02 | full pipeline claim→fetch→`@geo/core` checks→score→`completeJob` persists score+findings | int (PGlite + loopback) | `vitest run pipeline` | ❌ W0 | ⬜ pending |
| 4-WORK-02b | 2 | WORK-02 | deterministic fetch error (SSRF blocked) → `failJob` with FetchErrorCode, scoring call NOT made | int (PGlite + loopback) | `vitest run pipeline` | ❌ W0 | ⬜ pending |
| 4-WORK-03 | 2 | WORK-03 | `WORKER_CONCURRENCY=2`: third job not claimed while 2 in-flight; excess waits | unit (fake timers) | `vitest run worker` | ❌ W0 | ⬜ pending |
| 4-WORK-04a | 2 | WORK-04 | `renewLease` returns false mid-audit → in-flight audit aborted, `completeJob` NOT called (fencing) | unit (mock DAL) | `vitest run worker` | ❌ W0 | ⬜ pending |
| 4-WORK-04b | 2 | WORK-04 | `reclaimExpired` invoked on `RECLAIM_INTERVAL_MS` schedule | unit (fake timers + mock DAL) | `vitest run worker` | ❌ W0 | ⬜ pending |
| 4-WORK-04c | 2 | WORK-04 | SIGTERM: new claims stop, in-flight finishes, process exits (graceful drain) | unit (fake signal) | `vitest run worker` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/worker/package.json` (`@geo/worker`; deps `@anthropic-ai/sdk`, workspace `@geo/core`/`@geo/fetch`/`@geo/db`; dev: `vitest`, PGlite via `@geo/db` harness)
- [ ] `packages/worker/vitest.config.ts` (mirror `packages/db`)
- [ ] `packages/worker/tsup.config.ts` (dual ESM+CJS+d.ts; `entry: ['src/index.ts','src/main.ts']`)
- [ ] Constructor-injected `AnthropicMessagesClient` interface seam (mockable, no module mock)
- [ ] Reuse Phase 3 PGlite harness + Phase 2 loopback fetch fixtures (import, don't duplicate)

---

## Security Domain (ASVS L1)

| Threat | STRIDE | Mitigation (test-asserted) |
|--------|--------|----------------------------|
| LLM output injection (malformed `tool_use.input`) | Tampering | zod `GeoScoreSchema` validation; reject + `SCORING_MALFORMED_OUTPUT` (4-SCORE-04) |
| Lease-token forgery / stale-worker completion | Spoofing | Postgres `gen_random_uuid()` lease tokens; renewLease-false aborts in-flight (4-WORK-04a) |
| SSRF via audit URL | Elevation | `@geo/fetch createSafeFetcher()`; SSRF error fails job before any scoring call (4-WORK-02b) |
| Anthropic key exposure | Info disclosure | `ANTHROPIC_API_KEY` env-only, fail-fast assert at worker start; never committed |

---

## Manual-Only / Deferred Verifications

| Behavior | Requirement | Why Deferred | When verified |
|----------|-------------|--------------|---------------|
| Real prompt-cache hit against live Anthropic API (actual `cache_read_input_tokens` > 0 on 2nd call) | SCORE-03 | No live API spend in CI; mock proves wiring/shape | Phase 6 deploy-verify with real key (optional) |
| End-to-end audit round-trip with real LLM score | WORK-02 | Live API spend | Phase 6 `/audit` round-trip (DEPLOY-04) |

*All other phase behaviors have automated PGlite/loopback/mock-backed verification.*

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
