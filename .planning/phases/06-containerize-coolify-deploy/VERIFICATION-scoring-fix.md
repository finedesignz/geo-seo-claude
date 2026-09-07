---
verified: 2026-07-31
verifier: independent (goal-backward, adversarial, no self-report trusted)
goal: "geo-api produces real, non-null GEO scores in production"
branch: phase-01-geo-core-deterministic-package
head_commit: 77bf396
verdict: DO-NOT-SHIP
superseded_by: b7db9ff
superseded_on: 2026-09-06
---

## RESOLVED 2026-09-06

This verdict is superseded. It was accurate at `77bf396` on 2026-07-31, but the
blockers it names have since been fixed and shipped:

- **E2BIG** and **SCORING_TIMEOUT_MS** were fixed in `b7db9ff` (PR #2), merged to main.
- The malformed-output issue was already reported fixed in the original doc below.
- v1.0 shipped 2026-08-31: main is at `ea4f090`, and both Coolify apps are repointed
  to `main`.
- Live re-verification on 2026-09-06: `/healthz` returned `200 {"status":"ok","db":"ok"}`;
  an end-to-end audit completed successfully (status=done, score=34).

The historical verdict below is preserved unchanged for the record.

# Verification: geo-api scoring fix (commits 1a99595..77bf396)

## Executive summary

**Verdict: DO-NOT-SHIP.**

The specific bug the fix commits targeted (the model returning prose/refusal instead of
raw JSON, "SCORING_MALFORMED_OUTPUT") does appear genuinely fixed - it did not recur in
any of 3 fresh production trials. Scores that DO complete are real and differentiated,
not constant/degenerate.

But the phase goal is "geo-api produces real, non-null GEO scores in production" - a
system-level claim, not a claim about one specific error code - and that goal is NOT
met. Submitting 3 fresh audits against real, content-rich pages produced 1 success and
2 failures (33% success rate), via two DIFFERENT unaddressed failure modes that this fix
did not touch:

1. **E2BIG** - pages whose extracted findings are large enough to exceed the OS argv
   size limit crash the child_process spawn call itself. This error bypasses the
   `ScoringError`/retry machinery entirely, fails permanently on the FIRST attempt with
   no retry, and is not logged anywhere (not even by the new diagnostic logging this fix
   added in `pipeline.ts` - that logging only fires on the `ScoringError` path).
2. **SCORING_TIMEOUT (sustained)** - the `claude` CLI subprocess can consistently exceed
   the 60s timeout for a given page across all 3 retry attempts, exhausting the retry
   budget and failing permanently.

Across the full production `audits` table (14 historic rows + 3 new = 17), only 2 rows
have EVER reached `status=done` with a non-null score (12%). One passing job (the claim
under review) does not prove the fix; 3 fresh trials confirm it does not generalize.

---

## Claim 1: "399 tests passing, 0 failures, up from a 372 baseline"

**Status: PASS (current count only; baseline not independently verifiable)**

Ran the suite myself from repo root:

```
bun run --sequential --filter='*' test -- --run
```

Per-package results (all green):

| Package | Test files | Tests | Notes |
|---|---|---|---|
| @geo/api | 7 | 40 | passed |
| @geo/core | 7 | 106 | passed |
| @geo/cron | 2 | 16 | passed |
| @geo/db | 8 | 55 | +1 skipped |
| @geo/examples | 1 | 1 | passed |
| @geo/fetch | 11 | 122 | +7 todo |
| @geo/worker | 6 | 59 | passed |

Sum: 40 + 106 + 16 + 55 + 1 + 122 + 59 = **399 passing, 0 failing** - matches the claim
exactly. The "372 baseline" figure could not be independently corroborated (no reference
to it exists in `.planning/phases/06-containerize-coolify-deploy/*.md`), but this is a
historical/contextual claim, not load-bearing for the goal - the current run is what
matters and it is verified.

## Claim 2: "Production job bd38d162-bbc0-4dd3-a8df-00469c7e9760 has status done and score 26"

**Status: PASS (the specific row), but with a major caveat surfaced by the surrounding data**

Queried the live production Postgres directly via SSH + `docker exec ... psql`:

```
                  id                  |         url          | status | score | error_code | attempts
bd38d162-bbc0-4dd3-a8df-00469c7e9760 | https://example.com/ | done   |    26 |            |        1
```

Confirmed exactly as claimed.

**But the table-wide state at the time of this check was:**

```
 status |        error_code        | count | count(score)
 done   |                          |     1 |     1
 failed | FETCH_ERROR              |     2 |     0
 failed | SCORING_API_ERROR        |     3 |     0
 failed | SCORING_MALFORMED_OUTPUT |     3 |     0
 failed | max_attempts_exceeded    |     2 |     0
```

**Only 1 of 11 historic jobs (9%) had ever reached `done` with a score.** This job was
also against `example.com` - a near-blank, 21-word page, not a realistic target. This is
exactly the "one-off, not proof" risk called out in the verification brief.

## Claim 3: Reproducibility - 3 new audits against real, content-rich URLs

**Status: FAIL (1 of 3 succeeded, 67% failure rate)**

Submitted via `POST /audit` (consumer `dashboard`) against the live geo-api at
`https://ckmm0xfx45kxe3n9p44xkpx5.coolify.titaniumlabs.us`, polled to terminal, then
cross-checked against the DB row for each:

| URL | Job ID | Final status | Score | error_code | Attempts |
|---|---|---|---|---|---|
| https://en.wikipedia.org/wiki/Web_scraping | 7fa9929b | done | 63 | (attempt 1 timed out, attempt 2 succeeded) | 2 |
| https://stripe.com/blog | 7ffa1053 | **failed** | - | **E2BIG** | 1 (no retry) |
| https://www.anthropic.com/ | bd3affe9 | **failed** | - | SCORING_TIMEOUT | 3 (max attempts exhausted) |

None of the 3 new failures reproduced the original `SCORING_MALFORMED_OUTPUT` bug the
fix targeted - so that specific defect does appear resolved. But 2 of 3 real pages still
never produced a score, through mechanisms this fix did not address:

- **`stripe.com/blog` -> E2BIG, permanent, unlogged, un-retried.** Traced this in
  `packages/worker/src/cli-scorer.ts`: the findings JSON is passed to the `claude` CLI as
  a literal `argv` element (`buildCliArgv(buildCliPrompt(findings), model)` ->
  `spawn(bin, [..., prompt, ...])`). For a page with enough extracted content, this
  argv exceeds the OS `ARG_MAX`/`execve` limit and the `spawn()` call itself errors with
  `E2BIG` before any `claude` process starts. In `defaultSpawnFn`,
  `child.on("error", () => finish(null))` swallows the real error object and resolves
  with `exitCode: null`. Back in `pipeline.ts`, this raw error is NOT an instance of
  `ScoringError`, so it falls into the `// Non-ScoringError (unexpected) - fail the job`
  branch (line ~174), which calls `dal.failJob` directly - it never checks
  `attempts < maxAttempts`, so there is no retry regardless of budget, and there is no
  `console.error`/diagnostic log at all on this path (confirmed against
  `docker logs` for the worker container - no line for this job exists, unlike the two
  `SCORING_TIMEOUT` jobs, which DID log via the new `pipeline.ts` line this fix added).
  This is a real, unaddressed defect, not a fluke of this one page.
- **`anthropic.com` -> SCORING_TIMEOUT x3, exhausted.** The `claude` CLI subprocess did
  not complete within the 60s `SCORING_TIMEOUT_MS` on any of its 3 attempts. This is a
  genuine reliability gap (fixed timeout, no backoff/scaling), separate from the parsing
  bug this fix targeted, and it fully exhausts the retry budget for pages the CLI is
  simply slow to score.

## Claim 4: Are scores meaningful, or constant/degenerate?

**Status: PASS, but on a very thin sample (n=2 - every successful job that has ever existed)**

Compared the only two jobs that have ever reached `done` in the entire production table:

| Job | URL | Score | Word count | robots.txt | Structured data | Citability |
|---|---|---|---|---|---|---|
| bd38d162 | example.com | 26 | 21 | absent | none | 0 |
| 7fa9929b | en.wikipedia.org/.../Web_scraping | 63 | 5042 | present, page-specific content | 1 Article (valid) | 42 |

Scores are meaningfully different (26 vs 63) and track real, page-specific signal - a
near-blank page scores low with a 0 citability sub-score, a content-rich page with real
structured data scores much higher, and the `findings` payload for each job contains
page-specific content (actual `robots.txt` text, actual word counts, actual detected
schema.org types) rather than empty/generic placeholders. Scoring is not constant or
hollow when it completes.

**Caveat:** this is only 2 data points because the system fails to reach scoring at all
for the large majority of submitted jobs (see Claim 3) - "the scores that exist are
real" is a much weaker claim than "the system reliably produces scores."

## Claim 5: Deployed worker running commit 77bf396 or later

**Status: PASS**

SSH'd to the Coolify host and inspected the running container directly (Coolify's own
`git_commit_sha` API field is unhelpfully `"HEAD"`, and its `/deployments` endpoint
returned an empty list, so this was confirmed via `docker ps` image tags instead, which
Coolify stamps with the exact deployed commit SHA):

```
b1226r7ny7ic0sl1kdpkmi60-011827512021 | b1226r7ny7ic0sl1kdpkmi60:77bf396b3f64432f0d2baaf34806a639e4a03791
created 2026-07-31 01:18:58 UTC | Up 11 minutes (healthy)
```

Image tag is the exact `HEAD` commit (`77bf396b3f64432f0d2baaf34806a639e4a03791`,
matches local `git rev-parse HEAD` -> `77bf396...`). Confirmed the fix is live in the
worker that served all 4 audits checked in this report (the 1 original + 3 new).

Note: the sibling `geo-api` app (the HTTP intake service) is running an OLDER commit
(`3d36fff...`), not `77bf396`. This is expected and correct - the fix commits are
confined to `packages/worker` (see Claim 6) and do not touch the API service, so it had
no reason to redeploy.

## Claim 6: Regression scope - does the diff touch fetch/DB/API, or stay confined to the worker?

**Status: PASS**

```
git diff --stat 1a99595..77bf396
 packages/worker/src/__tests__/cli-scorer.test.ts | 18 +++++++++---
 packages/worker/src/cli-scorer.ts                | 35 ++++++++++++++----------
 packages/worker/src/pipeline.ts                  |  5 ++++
 3 files changed, 40 insertions(+), 18 deletions(-)
```

All 3 changed files are inside `packages/worker`. Read both non-test diffs in full:

- `cli-scorer.ts`: rewrites the CLI prompt's framing of the "no tools, return raw JSON"
  instruction from an adversarial "OVERRIDE...ignore every instruction...supersedes the
  tool instruction" framing (which the model was apparently refusing, treating it as a
  prompt-injection attempt against itself) to a plain "Runtime notice: no tools in this
  environment" framing placed BEFORE the untrusted findings block. No change to argv
  construction, spawn mechanics, or the OS-limit exposure identified in Claim 3.
- `pipeline.ts`: adds one `console.error` line logging `err.message` when a
  `ScoringError` is caught, for prod diagnosability. Does not touch the
  non-`ScoringError` branch (the one that swallows the `E2BIG` failure with no log).

No changes to `packages/fetch`, `packages/db`, `packages/api`, or any SSRF/fetch/DB/API
code path. Confirmed confined to the worker's scoring layer as claimed.

---

## Table-wide production state after this verification's 3 new submissions

```
 status |        error_code        | count | count(score)
 done   | SCORING_TIMEOUT (retried)|     1 |     1
 done   |                          |     1 |     1
 failed | E2BIG                    |     1 |     0
 failed | FETCH_ERROR              |     2 |     0
 failed | SCORING_API_ERROR        |     3 |     0
 failed | SCORING_MALFORMED_OUTPUT |     3 |     0
 failed | SCORING_TIMEOUT          |     1 |     0
 failed | max_attempts_exceeded    |     2 |     0
```

2 of 17 rows in the entire history of this table (12%) have ever reached a non-null
score. 1 of the 3 fresh, real-world URLs tried in this verification round succeeded
(33%).

## Final verdict

**DO-NOT-SHIP.**

The narrow bug the fix commits targeted (model treating the CLI output-format
instruction as a prompt injection and refusing / emitting prose instead of JSON) is
fixed and did not recur in 3 fresh trials. That part of the implementer's claim holds up.

But the phase goal as stated - "geo-api produces real, non-null GEO scores in
production" - is not achieved. 2 of 3 fresh real-content URLs failed to produce a score
in this round, through two different mechanisms this fix left completely unaddressed:
an un-retried, unlogged `E2BIG` crash for pages whose findings exceed the CLI argv size
limit, and a sustained `SCORING_TIMEOUT` that can exhaust the full retry budget for
pages the CLI is slow to score. Do not represent this as "scoring works in production" -
it works for small/simple pages and fails for realistic ones roughly two-thirds of the
time in this sample.

Recommended before shipping as fixed: (1) stop passing the findings JSON as a CLI argv
element - pipe it via stdin or a temp file instead, eliminating the `ARG_MAX` exposure
entirely; (2) add the same diagnostic logging this fix added for `ScoringError` to the
non-`ScoringError` catch branch in `pipeline.ts` so failures like `E2BIG` are not
silently opaque; (3) investigate whether 60s is an adequate CLI timeout, or whether it
needs to scale with page/findings size.
