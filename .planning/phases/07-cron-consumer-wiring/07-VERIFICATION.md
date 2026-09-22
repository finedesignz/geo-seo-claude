---
phase: 07-cron-consumer-wiring
verified: 2026-09-21T00:00:00Z
status: passed
score: 3/3 must-haves verified (in-repo + live)
covered_files:
  - .planning/phases/07-cron-consumer-wiring/07-01-PLAN.md
  - .planning/phases/07-cron-consumer-wiring/07-01-SUMMARY.md
  - .planning/phases/07-cron-consumer-wiring/07-02-PLAN.md
  - .planning/phases/07-cron-consumer-wiring/07-02-SUMMARY.md
  - .planning/phases/07-cron-consumer-wiring/07-03-PLAN.md
  - .planning/phases/07-cron-consumer-wiring/07-03-SUMMARY.md
  - packages/cron/src/cron.ts
  - packages/cron/src/env.ts
  - packages/cron/src/main.ts
  - packages/cron/src/__tests__/cron.test.ts
  - packages/cron/src/__tests__/env.test.ts
  - Dockerfile
  - .env.example
  - docs/deploy.md
  - docs/consumers.md
  - examples/how-inline-usage.ts
  - examples/ottolax-client.py
  - .planning/milestones/v1.0-REQUIREMENTS.md
covered_digest: "v1:sha256-manual:25dfe2cd47e3e46d41543f30df6bd7bee4fdc78e8b81e729d774ba1e5b8382cd"
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "2/3 must-haves verified (in-repo + live); 1/3 FAILED live (cron scheduled task disabled in production) (07-VERIFICATION.md, 2026-09-14)"
  gaps_closed:
    - "CONS-02 live API mechanism now proven end-to-end in prod (POST/GET contract matches openapi.json; real audits scoring 21-35 on real URLs as recently as 2026-09-07)"
    - "DEPLOY-02 live automatic firing — task `geo-cron-reaudit` (uuid tib0st8idrb0tg8gq7xt8vuk) re-enabled 2026-09-15T09:47Z after a 2-panel ENABLE verdict; three consecutive nightly runs (09-19, 09-20, 09-21) reached `done` with real scores (25, 25, 21) after an intervening worker-account outage was resolved. See evidence below."
  gaps_remaining: []
  caveats_open:
    - "CRON_TARGET_URLS is still the placeholder https://example.com in production config — real target-site selection remains an open product decision, not a technical gap"
    - "The SCORING_API_ERROR the worker threw on 09-16/17/18 carried no `detail` field (known diagnostics gap in packages/worker/src/cli-scorer.ts) — this made the three failing nights hard to diagnose and remains unfixed"
gaps: []
deploy02_reenable_evidence:
  disable_history: "Task disabled 2026-06-12T04:19:06Z; reason never recorded anywhere (git log, .planning/**, docs/, project memory all searched, see prior 09-14 investigation below — unchanged, kept for record)."
  reenable: "Re-enabled 2026-09-15T09:47Z after a 2-panel ENABLE verdict."
  post_reenable_failures:
    - "Runs 09-16, 09-17, 09-18 enqueued correctly (scheduler fired, jobs created) but the worker failed scoring on all three: error_code SCORING_API_ERROR with no `detail` field — a known diagnostics gap in packages/worker/src/cli-scorer.ts that throws sites without attaching failure detail."
    - "Root cause: the worker's CLAUDE_CODE_OAUTH_TOKEN account hit its usage limit. The account's usage window reset 2026-09-18 17:00 PT."
  post_reset_success:
    - "2026-09-19: job 5957bd65-2e39-4170-a8ed-cfd97bfdfb99 reached done, score 25"
    - "2026-09-20: job ad7ce538-acc6-4697-902e-a7752a8884dc reached done, score 25"
    - "2026-09-21: job cc7e55ad-0ce8-4064-bb79-11a041108e4d reached done, score 21"
  conclusion: "Three consecutive nightly scheduler-fired runs completed with real scores post-reset. DEPLOY-02's headline goal clause (scheduled re-audits run automatically) is now proven live, not merely deferred."
human_verification:
  - test: "After re-enabling the Coolify Scheduled Task, confirm it actually fires at the next `0 4 * * *` UTC boundary (or trigger manually from the Coolify UI) and a fresh `cron`-consumer job appears via `GET /audits`"
    expected: "A new job with consumer scoped to `cron` appears within one cadence window; `GET .../scheduled-tasks/{uuid}/executions` becomes non-empty"
    why_human: "Requires an operator action in the Coolify UI/API (enabling the task) that this read-only verification pass is not authorized to perform, plus waiting for/observing a real clock-driven fire"
  - test: "GEO_API_TOKEN=<live ottolax key> python3 examples/ottolax-client.py https://<fresh-url>"
    expected: "Prints {score, findings} after poll completes against the live service"
    why_human: "The underlying HTTP mechanism is proven live (openapi.json contract match, 401 enforcement, real scored jobs in GET /audits history), but no run using the actual reference `ottolax-client.py` script itself (vs. ad-hoc dashboard-token curl) was observed this session — POST would create a new job which the no-writes/no-triggering-sends constraint for this pass avoided running"
---

# Phase 7: Cron + Consumer Wiring — Verification Report

**Phase Goal:** Scheduled re-audits run automatically, hyperoptimizedwebsites (HOW) imports `@geo/core` inline, and ottolax triggers on-demand audits over HTTP — both consumers fully wired. (Requirements: DEPLOY-02, CONS-01, CONS-02. Mode tag on this phase is `mvp`, but the ROADMAP goal text is not phrased as a User Story — this predates the User-Story-format guard; verified against the plain goal text instead of blocking.)

**Verified:** 2026-09-21 (this pass; supersedes the 2026-09-14 `gaps_found` verification)
**Codebase checked:** `origin/main` (git-show, no checkout). **Note:** local `main` ref is stale (tracks the pre-fork upstream, last commit 2026-05-26) — it does NOT contain any of Phase 7's work. `origin/main` is the real trunk: PR #1 merged the `phase-01-geo-core-deterministic-package` branch (0 behind, only 3 docs/fix commits ahead), tag `v1.0` is an ancestor, both Coolify apps are deployed from `origin/main` at HEAD. All code/doc verification below is against `origin/main`; live checks are against the actual deployed Coolify apps.
**Status:** passed
**Re-verification:** Yes — a prior `07-VERIFICATION.md` pass (2026-09-14, `gaps_found`, 2/3) found the Coolify Scheduled Task `geo-cron-reaudit` disabled in production. This pass records that the task was re-enabled 2026-09-15T09:47Z after a 2-panel ENABLE verdict, hit a worker-side usage-limit outage on the first three post-enable nights (09-16/17/18), and then completed three consecutive real scheduler-fired runs (09-19/20/21) after the account's usage window reset. DEPLOY-02 is now PASS.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Scheduled re-audits run automatically (DEPLOY-02) | ✓ VERIFIED (live) | Code/tests/Dockerfile/docs all correct (`packages/cron/src/{cron,env,main}.ts`, 4 tests in `cron.test.ts`, `Dockerfile` copies `packages/cron/package.json` + `GEO_ROLE=cron` dispatch, `docs/deploy.md` §"Cron / scheduled re-audit"). **Live:** task `geo-cron-reaudit` (uuid `tib0st8idrb0tg8gq7xt8vuk`) re-enabled 2026-09-15T09:47Z. First three nights (09-16/17/18) enqueued fine but the worker failed scoring (`SCORING_API_ERROR`, root cause: worker `CLAUDE_CODE_OAUTH_TOKEN` usage-limit exhaustion, reset 2026-09-18 17:00 PT). Three consecutive nightly runs since the reset reached `done` with real scores: 09-19 job `5957bd65-2e39-4170-a8ed-cfd97bfdfb99` score 25; 09-20 job `ad7ce538-acc6-4697-902e-a7752a8884dc` score 25; 09-21 job `cc7e55ad-0ce8-4064-bb79-11a041108e4d` score 21. **Open caveat:** `CRON_TARGET_URLS` is still the placeholder `https://example.com` — real target-site selection is an open product decision. |
| 2 | HOW imports `@geo/core` inline, no HTTP (CONS-01) | ✓ VERIFIED (in-repo deliverable) · cross-repo wiring correctly deferred | `examples/how-inline-usage.ts` calls real `checkRobots`/`detectRendering` from `@geo/core` with an injected offline `Fetcher`; `docs/consumers.md` documents the `file:`/workspace/git/npm dependency options for the HOW repo. Actual edit to the `hyperoptimizedwebsites` repo is out of this repo's scope (rule 20) — correctly not attempted here, and not a gap for *this* repo. |
| 3 | ottolax triggers on-demand audits over HTTP (CONS-02) | ✓ VERIFIED (live mechanism) · reference client unexercised this session | `examples/ottolax-client.py` is stdlib-only, env-token-only, and its request/response shapes match the LIVE `/openapi.json` (`AuditSubmitResult`, `AuditPollResult` schemas fetched from the deployed service). Live proof the underlying HTTP mechanism works end-to-end: unauthenticated `POST /audit` → 401 (auth enforced); `GET /audits` (dashboard token) shows real completed jobs with real scores as recently as 2026-09-07 (`score:35`, `score:34`) and 2026-09-01 (`score:31`). Cross-repo wiring into the `ottolax` repo remains correctly deferred (rule 20). |

**Score:** 3/3 truths verified.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/cron/src/{env,cron,main}.ts` | fail-fast env, pure POST loop, one-shot entry | ✓ VERIFIED | Matches PLAN must-haves exactly: `assertEnv` throws naming the var (never the value), `parseTargetUrls` validates http(s) before any POST, `runCron` continues on per-URL failure, token never logged, exit code reflects partial failure |
| `packages/cron/src/__tests__/cron.test.ts` | in-process app+PGlite test | ✓ VERIFIED | Drives real `createApp` + real PGlite DAL via `app.request` as the injected fetch; asserts jobs persist `consumerId==='cron'`, `status==='queued'`; a bad URL (400) doesn't abort the batch |
| `Dockerfile` cron target | cron manifest copied, `GEO_ROLE=cron` dispatch | ✓ VERIFIED | `COPY packages/cron/package.json`, build step, `GEO_ROLE` role table documented at top of file |
| `.env.example` CRON block | CRON_TARGET_URLS/API_TOKEN/GEO_API_BASE_URL/CRON_SCHEDULE + `:cron`/`:ottolax` GEO_API_KEYS guidance | ✓ VERIFIED | Present, placeholders only, var names match `env.ts` exactly |
| `docs/deploy.md` cron section | Coolify Scheduled-Task runbook + >1h cadence warning | ✓ VERIFIED | §"Cron / scheduled re-audit (DEPLOY-02)" with `[HUMAN GATE]` steps, cadence-vs-dedup warning |
| `docs/consumers.md` | both consumer patterns, `/openapi.json` as source of truth | ✓ VERIFIED | CONS-01 + CONS-02 sections, dependency-wiring options for HOW documented |
| `examples/how-inline-usage.ts` (+ test) | real `@geo/core` import, offline | ✓ VERIFIED | Injected fake `Fetcher`, zero network |
| `examples/ottolax-client.py` | stdlib-only Python client, env token | ✓ VERIFIED | Contract matches live `/openapi.json` |
| Coolify Scheduled Task `geo-cron-reaudit` | armed and firing per `CRON_SCHEDULE` | ✓ VERIFIED — ENABLED, FIRING | Re-enabled 2026-09-15T09:47Z; three consecutive real scored runs 09-19/20/21 (see evidence above) |

### Live / Behavioral Checks (read-only)

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| API healthz | `curl .../healthz` | `{"status":"ok","db":"ok"}` (200) | ✓ PASS |
| OpenAPI contract shape | `curl .../openapi.json` | paths `[/healthz,/audit,/audit/{job_id},/audits]`; `AuditSubmitResult`/`AuditPollResult` schemas match `ottolax-client.py` | ✓ PASS |
| Auth enforced | unauthenticated `POST /audit` | 401 | ✓ PASS |
| Real recent audits succeeding | `GET /audits` (dashboard token) | jobs on 2026-09-07 (score 35, 34), 2026-09-01 (score 31), etc. — service is live and scoring correctly | ✓ PASS |
| Coolify scheduled task state | `GET /api/v1/applications/{app}/scheduled-tasks` | `enabled:true` (re-armed 2026-09-15T09:47Z) | ✓ PASS |
| Coolify scheduled task execution history | Nightly runs 09-19/20/21 | jobs `5957bd65...`, `ad7ce538...`, `cc7e55ad...` all reached `done` with scores 25/25/21 | ✓ PASS |
| Worker app health | `GET /api/v1/applications/{worker}` | `status:"running:healthy"`, `git_branch:"main"` | ✓ PASS |
| Both apps track `origin/main` | `git_branch` field on both apps | `"main"` on both | ✓ PASS (confirms 08-31 repoint) |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| DEPLOY-02 | Cron container re-audits configured sites via `/audit` | ✓ SATISFIED (live) | Code/tests/docs SAT; live scheduled firing confirmed via three consecutive real scored runs 09-19/20/21 (see evidence above). Open caveat: `CRON_TARGET_URLS` still placeholder. |
| CONS-01 | HOW imports `@geo/core` inline | ✓ SATISFIED (in-repo scope) | Offline example + test; cross-repo edit correctly out of scope |
| CONS-02 | ottolax HTTP consumer | ✓ SATISFIED | Client contract-correct and proven against the live, currently-scoring service |

### Anti-Patterns Found

None. No TODO/FIXME/XXX/HACK debt markers in any phase-modified file. The only "PLACEHOLDER" hits are the intentional, documented `.env.example`/`docs/deploy.md` secret placeholders (expected pattern, not a stub).

### Why Was the Scheduled Task Disabled? (investigated 2026-09-14, read-only; RESOLVED 2026-09-15 — task re-enabled)

**No reason is recorded anywhere.** A targeted search across every place this project keeps
history turned up nothing that explains, authorizes, or even mentions disabling
`geo-cron-reaudit`:

| Source searched | Result |
|---|---|
| `git log --all` 2026-06-08 to 2026-06-20 | 4 commits (`e03d45d`, `d2807b7`, `66c7979` CLI scoring path; `9af25c2` brotli/decompressor fix). None touches cron scheduling, the Coolify task, or any enable/disable flag. |
| `.planning/**` (all phases, `DEPLOY-RECORD.md`, all `07-*` docs) | Cron is discussed only as a deliverable to build and document. No disable event, no decision record. |
| `docs/deploy.md` | Documents how to CREATE the scheduled task. Silent on it ever being turned off. |
| Project memory dir (`MEMORY.md`, `geo-api-v1-ship-state.md`, `active-sessions.md`) | No entry contains "disabled", "paused", "turned off", or "re-arm" in connection with the cron task. |

The only hard fact is Coolify's own metadata: the task's `updated_at` is
`2026-06-12T04:19:06Z` and its executions list is empty.

**Circumstantial context (inference, NOT evidence -- do not cite as the cause):** that
timestamp lands inside the session logged as "UPDATE 2026-06-12 -- CLI/subscription scoring +
brotli fix + auto-refresh mount" in `geo-api-v1-ship-state.md`. Two adjacent notes are
suggestive: the 2026-06-10 entry records that the cron was emailing
`[cron] FAILED https://example.com: Unable to connect` on every run before its base-URL fix,
and the 2026-06-12 entry states jobs still would not process until the worker was restarted
(brotli bug). Switching off a scheduled task that could only produce failures while the
pipeline was being repaired would be a reasonable action to have taken -- but nobody wrote
down that they took it, and nobody re-armed it afterwards. The actual gap this exposes is
process, not intent: a live automation was turned off with no decision record and nothing
polling its state, so it stayed off for three months while the milestone was marked SHIP.

**Update 2026-09-15:** the task was re-enabled (uuid `tib0st8idrb0tg8gq7xt8vuk`, `enabled:true` at
2026-09-15T09:47Z) after a 2-panel ENABLE verdict. The disable-cause investigation above remains
accurate as a historical record — no reason for the original 2026-06-12 disable was ever found —
but it is no longer a live blocker.

### Gaps Summary

None open. The phase's build-time deliverable (code, tests, Docker wiring, docs) for all three requirements is solid and matches the plans exactly. The live gap identified in the 2026-09-14 pass — Coolify Scheduled Task `geo-cron-reaudit` disabled since 2026-06-12 with an empty execution history — was closed: the task was re-enabled 2026-09-15T09:47Z after a 2-panel ENABLE verdict. The first three post-enable nights (09-16/17/18) enqueued correctly but the worker failed scoring with `SCORING_API_ERROR` (root cause: the worker's `CLAUDE_CODE_OAUTH_TOKEN` account had hit its usage limit; the account's usage window reset 2026-09-18 17:00 PT). Three consecutive nightly runs since the reset (09-19, 09-20, 09-21) reached `done` with real scores (25, 25, 21), proving the scheduler-fired, end-to-end path now works in production.

CONS-01 and CONS-02 hold up as before: the in-repo deliverables are correct, and for CONS-02 the underlying live HTTP mechanism is provably working end-to-end (real scored audits through 09-21), which the June 2026-06-04 verification could not confirm since nothing was deployed yet.

**Two caveats remain open and are recorded honestly, not hidden:**
1. `CRON_TARGET_URLS` is still the placeholder `https://example.com` in production config. Real target-site selection (which sites the cron actually re-audits) remains an open product decision, not a technical gap.
2. The `SCORING_API_ERROR` diagnostics gap in `packages/worker/src/cli-scorer.ts` is unfixed: the throw site attaches no `detail` field, which made the three failing nights (09-16/17/18) hard to diagnose and would recur for any future scoring-path failure.

---

**Verdict: SHIP — 3/3 verified, 0 open gaps.** The Coolify Scheduled Task `geo-cron-reaudit` (uuid `tib0st8idrb0tg8gq7xt8vuk`) is re-enabled and has produced three consecutive real scheduler-fired, scored runs (09-19/20/21). CONS-01/CONS-02 remain ship-ready as documented (cross-repo wiring remains a legitimate separate-repo follow-up, not blocking this repo). Two non-blocking caveats carry forward as follow-up items: the placeholder `CRON_TARGET_URLS` needs a real product decision on target sites, and the `SCORING_API_ERROR` diagnostics gap in `cli-scorer.ts` should be fixed so a future scoring failure surfaces a detail message instead of a bare error code.

_Verified: 2026-09-21_
_Verifier: Claude (gsd-verifier). Supersedes the 2026-09-14 `gaps_found` pass; DEPLOY-02 gap closed per the re-enable/outage/recovery evidence recorded above. The 2026-09-14 disable-cause investigation (git log, `.planning/**`, `docs/`, project memory dir — no recorded reason found) stands unchanged as historical record._
