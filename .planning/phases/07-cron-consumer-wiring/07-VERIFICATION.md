---
phase: 07-cron-consumer-wiring
verified: 2026-06-04T21:20:00Z
status: human_needed
score: 3/3 must-haves verified (in-repo); 2 live confirmations DEFERRED-LIVE, 2 edits DEFERRED-CROSS-REPO
verdict: SHIP WITH NOTES
overrides_applied: 0
deferred:
  - truth: "Criterion 1 live — Coolify Scheduled Task fires on CRON_SCHEDULE and re-audit jobs appear in history"
    addressed_in: "Phase 6 operator deploy gate (DEFERRED-LIVE)"
    evidence: "07-CONTEXT D-7 / 07-VALIDATION DEFERRED-LIVE; depends on deployed geo-api not yet provisioned"
  - truth: "Criterion 3 live — ottolax client completes a real POST→poll→{score,findings} round-trip"
    addressed_in: "Phase 6 operator deploy gate (DEFERRED-LIVE)"
    evidence: "07-CONTEXT D-7; live round-trip needs deployed service"
  - truth: "HOW repo adds @geo/core file: dep and calls checkRobots/detectRendering inline"
    addressed_in: "Cross-repo follow-up (rule 20)"
    evidence: "Separate repo hyperoptimizedwebsites; out of session confinement"
  - truth: "ottolax repo integrates the Python client with its GEO_API_KEYS bearer"
    addressed_in: "Cross-repo follow-up (rule 20)"
    evidence: "Separate repo ottolax; out of session confinement"
human_verification:
  - test: "After Phase 6 deploy: register Coolify Scheduled Task (bun packages/cron/dist/main.js, 0 4 * * *), set CRON_* + :cron GEO_API_KEYS entry, trigger manually"
    expected: "New cron-consumer jobs appear via GET /audit/{id}; second fire within 1h dedups"
    why_human: "Requires live deployed geo-api + Coolify operator access (DEFERRED-LIVE)"
  - test: "After deploy: GEO_API_TOKEN=<ottolax key> python3 examples/ottolax-client.py https://example.com"
    expected: "Prints {score, findings} after poll completes against live service"
    why_human: "Requires live deployed geo-api with worker (DEFERRED-LIVE)"
---

# Phase 7: Cron + Consumer Wiring — Verification Report

**Phase Goal:** Scheduled re-audits run automatically, HOW imports `@geo/core` inline, and ottolax triggers on-demand audits over HTTP — both consumers fully wired.
**Verified:** 2026-06-04T21:20:00Z
**Status:** human_needed (in-repo PASS; live + cross-repo legitimately deferred)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Criterion | Req | Status | Evidence |
|---|-----------|-----|--------|----------|
| 1 | Cron fires on schedule, POSTs re-audit per URL, results in history | DEPLOY-02 | ✓ PASS (code+test) · DEFERRED-LIVE (firing) | `runCron` loop `packages/cron/src/cron.ts:42-82`; in-process test drives real `createApp`+PGlite, asserts 2 jobs scoped `consumerId==='cron'`, status `queued` (`cron.test.ts:50-76`). 16/16 cron tests pass. Live Coolify firing deferred. |
| 2 | HOW imports `@geo/core` inline, NO HTTP | CONS-01 | ✓ PASS NOW | `examples/how-inline-usage.ts:64-71` calls real `checkRobots(siteUrl, fakeFetcher)` + `detectRendering(html)` from `@geo/core` barrel; offline test asserts `robots.aiCrawlerStatus.GPTBot==='BLOCKED'`, `rendering.rendering==='ssr'` with injected fetcher, zero network (`how-inline-usage.test.ts:13-31`). 1/1 pass. |
| 3 | ottolax POST/poll/score over HTTP w/ bearer | CONS-02 | ✓ PASS (client+contract) · DEFERRED-LIVE (round-trip) | `examples/ottolax-client.py` stdlib-only (`urllib`), env-only token (`_token()` exits if unset, never printed), `submit`→`POST /audit {url}`→job_id, `poll`→`GET /audit/{id}` until terminal, parses `{status,score,findings,error_code}` matching `audit-post.ts`/`audit-get.ts`. `py_compile` OK. Live round-trip deferred. |

**Score:** 3/3 criteria satisfied for the buildable/testable deliverable.

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `packages/cron/src/{env,cron,main}.ts` | ✓ VERIFIED | env fail-fast (`assertEnv` throws on missing CRON_*, strips trailing slash); `parseTargetUrls` validates http(s) up front; `main.ts` exit 1 on any failure |
| `packages/cron/src/__tests__/cron.test.ts` | ✓ VERIFIED | 4 cases: scoped jobs, continue-on-400, 401-no-throw, thrown-fetch-continues |
| `examples/how-inline-usage.ts` (+test) | ✓ VERIFIED | real `@geo/core` exports, injected Fetcher, offline |
| `examples/ottolax-client.py` | ✓ VERIFIED | stdlib only, env token, contract-correct |
| `docs/consumers.md` | ✓ VERIFIED | both patterns; `/openapi.json` as source of truth; `file:` dep guidance |
| `Dockerfile` cron target | ✓ VERIFIED | `bun packages/cron/dist/main.js` run target documented; `COPY packages/cron/package.json` (line 27) |
| `.env.example` CRON block | ✓ VERIFIED | CRON_TARGET_URLS/API_TOKEN/SCHEDULE + GEO_API_BASE_URL + GEO_API_KEYS `:cron`/`:ottolax`; placeholders only |
| `docs/deploy.md` cron section | ✓ VERIFIED | Scheduled-task runbook + UTC note + ⚠️ >1h-vs-dedup cadence warning (lines 152-205) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Cron suite (loop, env fail-fast, in-process app+PGlite scoping) | `bun run --cwd packages/cron test -- --run` | 2 files, 16 tests pass | ✓ PASS |
| CONS-01 offline proof | `bun run --cwd examples test -- --run` | 1 file, 1 test pass | ✓ PASS |
| CONS-02 client validity | `python3 -m py_compile examples/ottolax-client.py` | PYCOMPILE_OK | ✓ PASS |
| Full-workspace regression | `bun run --filter '*' test` | core 106, fetch 116, examples 1, cron 16, db 55, worker 38, api 40 — all pass, 0 fail | ✓ PASS |

### Security Checks

| Check | Status | Evidence |
|-------|--------|----------|
| Cron token never logged | ✓ | `cron.ts` logs url + job_id/status only; header value excluded by comment+code; `env.ts` errors name var not value |
| Cron does not fetch audited URLs (worker owns SSRF) | ✓ | `runCron` only POSTs to `${baseUrl}/audit`; no fetch of target URLs |
| ottolax token env-only, no hardcode | ✓ | `_token()` reads `GEO_API_TOKEN`, exits if unset, never prints |
| No hardcoded secrets in examples/docs/.env.example | ✓ | grep for `sk-ant-`/`olx_`/UUID found none; only `REPLACE_ME_*` placeholders |

### Requirements Coverage

| Req | Description | Status | Evidence |
|-----|-------------|--------|----------|
| DEPLOY-02 | Cron re-audits configured list via /audit | ✓ SATISFIED (live DEFERRED) | cron package + tests + Dockerfile/deploy runbook |
| CONS-01 | HOW imports @geo/core inline | ✓ SATISFIED NOW | offline example+test |
| CONS-02 | ottolax HTTP consumer | ✓ SATISFIED (live DEFERRED) | Python client + consumers.md |

### Deferred Items (not gaps)

| # | Item | Addressed In |
|---|------|--------------|
| 1 | Criterion 1 live firing | Phase 6 operator deploy gate (DEFERRED-LIVE) |
| 2 | Criterion 3 live round-trip | Phase 6 operator deploy gate (DEFERRED-LIVE) |
| 3 | HOW repo `@geo/core` dep wiring | Cross-repo follow-up (rule 20) |
| 4 | ottolax repo client integration | Cross-repo follow-up (rule 20) |

### Anti-Patterns Found

None. No TODO/FIXME/XXX/placeholder debt markers in phase-modified files; no stub returns; no hardcoded empty data feeding output.

### Gaps Summary

No real (non-deferred) gaps. All in-repo artifacts exist, are substantive, wired, and pass their suites. The only outstanding items are the documented DEFERRED-LIVE confirmations (gated on the Phase 6 operator Coolify deploy) and the DEFERRED-CROSS-REPO edits to the HOW and ottolax repos (rule 20 confinement) — both legitimately out of this phase's scope and not phase-failing.

---

**Verdict: SHIP WITH NOTES** — Phase 7 goal achieved for every buildable/testable deliverable (3/3 criteria, 3/3 requirements, full-suite green, security clean). Live scheduled firing + live ottolax round-trip are DEFERRED-LIVE behind the Phase 6 operator gate; HOW/ottolax repo wiring is DEFERRED-CROSS-REPO. Carry the two human_verification items into the post-deploy verify pass.

_Verified: 2026-06-04T21:20:00Z_
_Verifier: Claude (gsd-verifier)_
