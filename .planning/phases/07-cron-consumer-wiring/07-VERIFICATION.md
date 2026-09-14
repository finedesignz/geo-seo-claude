---
phase: 07-cron-consumer-wiring
verified: 2026-09-14T00:00:00Z
status: gaps_found
score: 2/3 must-haves verified (in-repo + live); 1/3 FAILED live (cron scheduled task disabled in production)
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
  previous_status: human_needed
  previous_score: "3/3 in-repo; 2 items DEFERRED-LIVE; 2 items DEFERRED-CROSS-REPO (07-VERIFICATION.md, 2026-06-04)"
  gaps_closed:
    - "CONS-02 live API mechanism now proven end-to-end in prod (POST/GET contract matches openapi.json; real audits scoring 21-35 on real URLs as recently as 2026-09-07)"
  gaps_remaining:
    - "DEPLOY-02 live automatic firing — still not proven, and now affirmatively disproven (see gap below), not merely deferred"
  regressions:
    - "Coolify Scheduled Task `geo-cron-reaudit` (uuid tib0st8idrb0tg8gq7xt8vuk) is enabled:false with an EMPTY executions array as of verification time. Last touched 2026-06-12T04:19:06Z. It was never re-armed after that session, so the phase's headline goal clause has been silently false in production for ~3 months while the milestone was marked SHIP / SAT."
gaps:
  - truth: "Scheduled re-audits run automatically (Coolify Scheduled Task fires on CRON_SCHEDULE, re-audit jobs appear in history) — ROADMAP Phase 7 goal clause 1 / DEPLOY-02"
    status: failed
    reason: "Live Coolify API for the deployed geo-api application (ckmm0xfx45kxe3n9p44xkpx5) returns the scheduled task `geo-cron-reaudit` with `enabled:false` and `GET .../scheduled-tasks/tib0st8idrb0tg8gq7xt8vuk/executions` returns `[]` (empty). The code, tests, Dockerfile wiring, and docs are all correct — but the actual production automation is currently OFF and has apparently never recorded a scheduler-fired execution. This is not a 'deferred, needs live confirmation' item — it is a positive, current, read-only-verified failure of the observable truth."
    artifacts:
      - path: "Coolify scheduled task tib0st8idrb0tg8gq7xt8vuk (application ckmm0xfx45kxe3n9p44xkpx5)"
        issue: "enabled=false, updated_at=2026-06-12T04:19:06Z, executions=[] — never armed/fired since that date"
    disable_cause_investigation:
      performed: "2026-09-14 (read-only)"
      sources_searched:
        - "git log --all across 2026-06-08..2026-06-20 (4 commits, none touching cron scheduling)"
        - ".planning/** (all phase dirs, DEPLOY-RECORD.md, 07-* plan/summary/discussion/validation docs)"
        - "docs/deploy.md"
        - "C:/Users/artic/.claude/projects/C--Users-artic-GitHub-geo-seo-claude/memory/ (MEMORY.md, geo-api-v1-ship-state.md, active-sessions.md)"
      finding: "NO REASON IS RECORDED ANYWHERE. Not one commit message, planning doc, deploy record, or memory entry states that geo-cron-reaudit was disabled, by whom, or why. The disable is attested only by Coolify's own `updated_at` on the task (2026-06-12T04:19:06Z)."
      circumstantial_context_only: >
        The task's updated_at falls inside the 2026-06-12 session recorded in
        geo-api-v1-ship-state.md ("UPDATE 2026-06-12 -- CLI/subscription scoring +
        brotli fix + auto-refresh mount"). That session's own notes say every audit
        was still failing and that "jobs still won't *process* until the worker is
        restarted (brotli bug)", and the 2026-06-10 note records that the cron had
        been emailing "[cron] FAILED https://example.com: Unable to connect" on every
        run. A plausible reading is that the task was switched off to stop a noisy,
        uselessly-failing job while scoring was being fixed, and then simply never
        re-armed. THIS IS INFERENCE, NOT EVIDENCE -- no document says it. Do not cite
        it as the cause.
    missing:
      - "Operator/executor must re-enable the Coolify Scheduled Task (PATCH scheduled-tasks/{uuid} enabled=true, or recreate it) on the geo-api application"
      - "After enabling, wait for (or manually trigger) one fire and confirm a new job appears in GET /audits with the `cron` consumer's bearer, and that the executions endpoint is non-empty"
      - "Add a monitoring/alerting check (or a periodic deploy-verify assertion) that the scheduled task's `enabled` flag and last-execution recency are checked — this regression sat undetected for ~3 months because nothing polled it"
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

**Verified:** 2026-09-14 (this pass; supersedes the 2026-06-04 `human_needed` verification)
**Codebase checked:** `origin/main` (git-show, no checkout). **Note:** local `main` ref is stale (tracks the pre-fork upstream, last commit 2026-05-26) — it does NOT contain any of Phase 7's work. `origin/main` is the real trunk: PR #1 merged the `phase-01-geo-core-deterministic-package` branch (0 behind, only 3 docs/fix commits ahead), tag `v1.0` is an ancestor, both Coolify apps are deployed from `origin/main` at HEAD. All code/doc verification below is against `origin/main`; live checks are against the actual deployed Coolify apps.
**Status:** gaps_found
**Re-verification:** Yes — a prior `07-VERIFICATION.md` (2026-06-04, `human_needed`) already existed in this phase directory; this pass re-checked it against current `origin/main` and live production state, and found a regression the prior pass could not have seen (live deploy hadn't happened yet on 06-04).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Scheduled re-audits run automatically (DEPLOY-02) | ✗ FAILED (live) | Code/tests/Dockerfile/docs all correct (`packages/cron/src/{cron,env,main}.ts`, 4 tests in `cron.test.ts`, `Dockerfile` copies `packages/cron/package.json` + `GEO_ROLE=cron` dispatch, `docs/deploy.md` §"Cron / scheduled re-audit"). **Live:** `GET /api/v1/applications/ckmm0xfx45kxe3n9p44xkpx5/scheduled-tasks` → `{"uuid":"tib0st8idrb0tg8gq7xt8vuk","name":"geo-cron-reaudit","enabled":false,"updated_at":"2026-06-12T04:19:06Z"}`; `GET .../scheduled-tasks/tib0st8idrb0tg8gq7xt8vuk/executions` → `[]`. Disabled since 2026-06-12, never fired via the scheduler, undetected for ~3 months. |
| 2 | HOW imports `@geo/core` inline, no HTTP (CONS-01) | ✓ VERIFIED (in-repo deliverable) · cross-repo wiring correctly deferred | `examples/how-inline-usage.ts` calls real `checkRobots`/`detectRendering` from `@geo/core` with an injected offline `Fetcher`; `docs/consumers.md` documents the `file:`/workspace/git/npm dependency options for the HOW repo. Actual edit to the `hyperoptimizedwebsites` repo is out of this repo's scope (rule 20) — correctly not attempted here, and not a gap for *this* repo. |
| 3 | ottolax triggers on-demand audits over HTTP (CONS-02) | ✓ VERIFIED (live mechanism) · reference client unexercised this session | `examples/ottolax-client.py` is stdlib-only, env-token-only, and its request/response shapes match the LIVE `/openapi.json` (`AuditSubmitResult`, `AuditPollResult` schemas fetched from the deployed service). Live proof the underlying HTTP mechanism works end-to-end: unauthenticated `POST /audit` → 401 (auth enforced); `GET /audits` (dashboard token) shows real completed jobs with real scores as recently as 2026-09-07 (`score:35`, `score:34`) and 2026-09-01 (`score:31`). Cross-repo wiring into the `ottolax` repo remains correctly deferred (rule 20). |

**Score:** 2/3 truths verified; 1/3 FAILED (live regression, not a deferred item).

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
| Coolify Scheduled Task `geo-cron-reaudit` | armed and firing per `CRON_SCHEDULE` | ✗ **NOT VERIFIED — DISABLED** | `enabled:false`, `executions:[]` (live API check, read-only) |

### Live / Behavioral Checks (read-only)

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| API healthz | `curl .../healthz` | `{"status":"ok","db":"ok"}` (200) | ✓ PASS |
| OpenAPI contract shape | `curl .../openapi.json` | paths `[/healthz,/audit,/audit/{job_id},/audits]`; `AuditSubmitResult`/`AuditPollResult` schemas match `ottolax-client.py` | ✓ PASS |
| Auth enforced | unauthenticated `POST /audit` | 401 | ✓ PASS |
| Real recent audits succeeding | `GET /audits` (dashboard token) | jobs on 2026-09-07 (score 35, 34), 2026-09-01 (score 31), etc. — service is live and scoring correctly | ✓ PASS |
| Coolify scheduled task state | `GET /api/v1/applications/{app}/scheduled-tasks` | `enabled:false` | ✗ FAIL |
| Coolify scheduled task execution history | `GET /api/v1/applications/{app}/scheduled-tasks/{uuid}/executions` | `[]` (empty) | ✗ FAIL |
| Worker app health | `GET /api/v1/applications/{worker}` | `status:"running:healthy"`, `git_branch:"main"` | ✓ PASS |
| Both apps track `origin/main` | `git_branch` field on both apps | `"main"` on both | ✓ PASS (confirms 08-31 repoint) |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| DEPLOY-02 | Cron container re-audits configured sites via `/audit` | ✗ BLOCKED (live) | Code/tests/docs SAT; live scheduled firing is OFF in production (see gap) |
| CONS-01 | HOW imports `@geo/core` inline | ✓ SATISFIED (in-repo scope) | Offline example + test; cross-repo edit correctly out of scope |
| CONS-02 | ottolax HTTP consumer | ✓ SATISFIED | Client contract-correct and proven against the live, currently-scoring service |

### Anti-Patterns Found

None. No TODO/FIXME/XXX/HACK debt markers in any phase-modified file. The only "PLACEHOLDER" hits are the intentional, documented `.env.example`/`docs/deploy.md` secret placeholders (expected pattern, not a stub).

### Why Was the Scheduled Task Disabled? (investigated 2026-09-14, read-only)

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

**This verification did not enable the task** (read-only mandate; re-arming a production
scheduled automation is an operator action).

### Gaps Summary

The phase's build-time deliverable (code, tests, Docker wiring, docs) for all three requirements is genuinely solid and matches the plans exactly — this is not a stub/placeholder problem. The gap is entirely operational and entirely live: the Coolify Scheduled Task that is supposed to make "scheduled re-audits run automatically" true has been `enabled:false` since 2026-06-12 (per its own `updated_at`), with an empty execution history recorded by Coolify's own API. The original 2026-06-04 verification correctly deferred this as "not yet deployed" — but the milestone was later shipped (2026-08-31, per project memory) and the task was never re-armed, so the phase's headline goal clause ("scheduled re-audits run automatically") has been silently false in production ever since, undetected because nothing polls the scheduled-task state or its execution history. This is a real, current, read-only-verified regression, not a deferred/out-of-scope item.

CONS-01 and CONS-02 hold up: the in-repo deliverables are correct, and for CONS-02 the underlying live HTTP mechanism is now provably working end-to-end (real scored audits in the last week), which the June verification could not confirm since nothing was deployed yet.

---

**Verdict: DO NOT SHIP AS "DONE" — 1 live gap.** Re-enable the Coolify Scheduled Task `geo-cron-reaudit` (uuid `tib0st8idrb0tg8gq7xt8vuk`) on the `geo-api` application, confirm one real fire (executions endpoint becomes non-empty, a new `cron`-consumer job appears), and add a recurring check so this can't silently regress again. CONS-01/CONS-02 are ship-ready as documented (cross-repo wiring remains a legitimate separate-repo follow-up, not blocking this repo).

_Verified: 2026-09-14_
_Verifier: Claude (gsd-verifier). 2026-09-14 addendum: disable-cause investigation across git log, `.planning/**`, `docs/`, and the project memory dir found no recorded reason; the FAILED cron finding stands unchanged._
