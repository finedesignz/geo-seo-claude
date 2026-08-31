---
last_mapped_commit: 9af25c25
focus: concerns
analysis_date: 2026-07-24
---

# Codebase Concerns

**Analysis Date:** 2026-07-24

The repo holds **two parallel implementations** of the same GEO/SEO capability:

1. **`packages/` — the TypeScript/Bun v1.0 product** (`@geo/core`, `@geo/fetch`, `@geo/db`,
   `@geo/api`, `@geo/worker`, `@geo/cron`), deployed as one Docker image with role dispatch.
2. **`scripts/` + `skills/` — the original Python/Claude-Code-skill toolkit** (standalone
   analysis scripts plus a small Flask CRM UI at `scripts/webapp/app.py`).

Most concerns below sit at the seam between these two, in the deployment path, or in the two
newest and least battle-tested surfaces: the Bun fetch/decompression stack and the Claude Code
CLI subscription scoring path.

## Tech Debt

**Two implementations of the same domain logic (Python `scripts/` vs TypeScript `packages/`):**
- Issue: citability scoring, llms.txt generation, robots/sitemap fetching, and page fetching all
  exist twice — once in Python, once in TypeScript — with no shared spec and no cross-check.
- Files: `scripts/citability_scorer.py` vs `packages/core/src/citability.ts`;
  `scripts/llmstxt_generator.py` vs `packages/core/src/llmstxt.ts`;
  `scripts/fetch_page.py` vs `packages/fetch/src/safe-fetcher.ts` + `packages/core/src/robots.ts`.
- Impact: scoring drift between the skill path and the API path — the same URL can produce two
  different scores with no way to tell which is authoritative. Bug fixes land in one side only
  (the SSRF/size/decompression hardening exists ONLY in `packages/fetch`; the Python
  `requests.get` paths have none of it).
- Fix approach: declare `packages/core` the single source of truth, then either (a) reduce the
  Python scripts to thin clients of the HTTP API (`docs/consumers.md` already documents a Python
  client), or (b) explicitly freeze and document the Python side as legacy/offline-only.

**Python scripts carry none of the fetch hardening the TS stack has:**
- Issue: `scripts/*.py` still use raw `requests.get` with a hardcoded browser User-Agent — no
  SSRF/IP classification, no redirect policy, no response-size cap, no decompression-bomb guard.
- Files: `scripts/fetch_page.py`, `scripts/brand_scanner.py`, `scripts/citability_scorer.py`,
  `scripts/llmstxt_generator.py`, `scripts/crm_dashboard.py`.
- Impact: any Python entry point that accepts a user-supplied URL is an SSRF vector against
  whatever host runs it, and is unbounded in memory. `packages/fetch` solved all of this.
- Fix approach: route Python URL fetches through the API, or port the guard set
  (`packages/fetch/src/ip-validator.ts`, `dns-resolve.ts`, `decompression.ts`) to a shared
  `scripts/http.py`.

**Broad `except Exception` / bare `except` swallowing errors in the Python scripts:**
- Issue: network and parse paths catch `Exception` and either `pass` or append a generic string,
  discarding the real failure mode.
- Files: `scripts/brand_scanner.py`, `scripts/fetch_page.py` (sitemap crawl paths),
  `scripts/citability_scorer.py`, `scripts/llmstxt_generator.py`.
- Impact: real failures (bad JSON shape, DNS, TLS) are indistinguishable from "site has no data";
  silent `pass` in the sitemap crawl hides child-sitemap fetch failures so partial results look
  complete.
- Fix approach: narrow the except clauses (`requests.RequestException`, `json.JSONDecodeError`),
  log the exception type, and surface a partial-result flag in the JSON output.

**No Python dependency pinning; no lockfile:**
- Issue: `requirements.txt` uses floating ranges with no lockfile committed. The Bun side is
  correctly locked (`bun.lock`, `bun install --frozen-lockfile` in the Dockerfile).
- Files: `requirements.txt`.
- Impact: non-reproducible installs on the Python half; a patch release of a parser can change
  scoring output with no repo change.
- Fix approach: commit a `requirements.lock` / `uv.lock` (`install.sh` already references `uv`).

**Docker build compiles the six packages as one sequential `RUN` chain:**
- Issue: `Dockerfile` builds core → fetch → db → api → worker → cron in a single hand-ordered
  `RUN cd ... && cd ...` chain because parallel builds raced on DTS emit (commit `c40a1ad`).
- Files: `Dockerfile` (build stage).
- Impact: build order is manual and unenforced — adding a package or changing a dependency edge
  silently breaks the build with a confusing type error. No cache granularity: any source change
  rebuilds all six.
- Fix approach: adopt a real task runner with a declared dep graph (turbo/nx/`bun --filter`), or
  at minimum assert the order matches the workspace dependency graph in CI.

**No root-level build/test/lint scripts:**
- Issue: root `package.json` is `{ private, workspaces }` only — no `build`, `test`, `lint`,
  `typecheck` script. Every command must be run per package.
- Files: `package.json`.
- Impact: no single command proves the repo is green; CI and the Dockerfile each re-encode the
  package list independently (already drifted once — `examples/package.json` had to be added to
  two stages in `8b82da6`).
- Fix approach: add root scripts that fan out over the workspace and have the Dockerfile call them.

## Known Bugs

**Open/recently-closed bug references:** the only in-repo bug marker is `BUG #3` in
`packages/fetch/src/__tests__/readbody-error.test.ts`, which covers the fix at HEAD (`9af25c2`,
"contain decompressor errors + avoid Bun brotli crash"). There are no open `TODO`/`FIXME`/`HACK`
markers anywhere in `packages/*/src` — the two `XXX` hits in `packages/core/src/schema.ts`
(lines 68, 158) are placeholder literals in generated JSON-LD templates, not defects.

**`robots.txt` Sitemap-line handling in the Python fetcher:**
- Symptoms: the defensive re-prepend logic (`if not sitemap_url.startswith("http"): sitemap_url =
  "http" + sitemap_url`) mangles any sitemap value that legitimately does not start with `http`
  (relative or scheme-less), producing `httpsitemap...`-style garbage.
- Files: `scripts/fetch_page.py` (robots parsing, ~lines 260-265).
- Trigger: a robots.txt with a relative or scheme-less `Sitemap:` directive.
- Workaround: none; the TS equivalent (`packages/core/src/robots.ts`) is unaffected.

## Security Considerations

**Webhook deliveries are unsigned:**
- Risk: `deliverWebhook` POSTs audit results to a consumer-supplied `callback_url` with no HMAC
  signature and no shared secret. A consumer cannot verify the payload came from this service,
  and cannot distinguish a replay.
- Files: `packages/worker/src/webhook.ts`.
- Current mitigation: strong outbound hardening — the SSRF-safe requester re-resolves and
  IP-classifies the host on every attempt (TOCTOU-safe), refuses redirects, caps the response at
  64 KiB, 5s timeout, 2 retries, and delivery is non-fatal so failures never wedge a job.
- Recommendations: add an `X-Geo-Signature` HMAC over the raw body with a per-consumer secret plus
  a timestamp header, and document verification in `docs/consumers.md`.

**No rate limiting or request-size limit on the HTTP API:**
- Risk: nothing in `packages/api/src` implements rate limiting or per-consumer quota. An
  authenticated consumer (or a leaked key) can enqueue unbounded audit jobs, each of which causes
  outbound fetches and a paid/subscription-billed model call.
- Files: `packages/api/src/app.ts`, `packages/api/src/routes/audit-post.ts`.
- Current mitigation: bearer auth is required on every data route and comparison is constant-time
  (`packages/api/src/middleware/auth.ts`), so this is an authenticated-abuse surface, not an open
  one.
- Recommendations: per-`consumer_id` token bucket on `POST /audits`, plus a body-size cap, plus a
  queue-depth ceiling per consumer.

**API keys are a flat env-var string with no rotation or revocation path:**
- Risk: `GEO_API_KEYS` is a comma-separated `token:consumer_id` list parsed once at startup.
  Revoking or rotating a key requires an env change and a redeploy; there is no per-key expiry,
  no last-used audit trail, and keys sit in plaintext in the Coolify env.
- Files: `packages/api/src/middleware/auth.ts` (`parseApiKeys`).
- Current mitigation: tokens are hashed to a fixed-length digest and compared with
  `timingSafeEqual`; the `Authorization` header is never logged; parsing fails fast when the var
  is missing.
- Recommendations: move keys into the `consumers` table with a hashed column, expiry, and a
  revocation flag; keep the env var only as a bootstrap path.

**Claude CLI subscription token in the container env:**
- Risk: `SCORING_PROVIDER=cli` requires `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived subscription
  token) to be present in the worker container's environment, where it is visible to any process
  in that container — including the `claude` CLI subprocess and anything the model-driven path
  could be induced to run.
- Files: `packages/worker/src/env.ts`, `packages/worker/src/cli-scorer.ts`, `Dockerfile`
  (runtime stage installs `@anthropic-ai/claude-code`).
- Current mitigation: the child is spawned with no bypass flags, `ANTHROPIC_API_KEY` is stripped
  from the child env (so it cannot silently fall back to API billing), the child gets its own
  process group and is SIGKILLed on timeout or lease-loss abort, and env errors name the variable
  without echoing its value.
- Recommendations: scope the token to the worker resource only (api/cron roles carry the CLI
  binary but do not need the token); treat any prompt content reaching the CLI as untrusted input
  and keep the prompt strictly templated from validated fields.

**Flask CRM UI has no auth and a debug-mode entry point:**
- Risk: `scripts/webapp/app.py` ends in `app.run(debug=debug, port=5050)`. Run with debug on and
  bound off-localhost, the Werkzeug debugger is remote code execution. There is no login on the
  UI at all.
- Files: `scripts/webapp/app.py` (line 215).
- Current mitigation: local-only by convention; not part of the Docker image or any deployed role.
- Recommendations: hard-fail if `debug` is on and the bind host is not loopback; or drop the
  Flask UI in favor of the API + a consumer client.

## Performance Bottlenecks

**Model scoring is the dominant per-job cost and has no caching:**
- Problem: every audit job runs a full model scoring call; identical or near-identical page
  content is re-scored from scratch.
- Files: `packages/worker/src/scorer.ts`, `packages/worker/src/cli-scorer.ts`,
  `packages/worker/src/pipeline.ts`.
- Cause: no content-hash keyed result cache between fetch and score.
- Improvement path: hash the normalized extracted content and short-circuit to the previous
  score when unchanged (a re-audit of an unchanged site should cost zero model calls).

**CLI scoring spawns a fresh `claude` process per job:**
- Problem: `SCORING_PROVIDER=cli` pays full CLI process startup (Node + CLI boot) on every single
  audit, and holds the job lease for that whole window.
- Files: `packages/worker/src/cli-scorer.ts`.
- Cause: one-shot `claude -p ... --output-format stream-json` per score by design.
- Improvement path: batch several pages per invocation, or keep `SCORING_PROVIDER=api` for
  high-volume operation and reserve CLI mode for subscription-billed low-volume runs.

## Fragile Areas

**Bun's `node:zlib` brotli decoder (the reason for the HEAD fix):**
- Files: `packages/fetch/src/safe-fetcher.ts` (request headers ~line 247; stream error wiring
  ~line 444), `packages/fetch/src/decompression.ts`.
- Why fragile: Bun's baseline `node:zlib` brotli decoder throws
  `ERR_BROTLI_DECODER_ERROR_FORMAT_RESERVED` on streams Node decodes fine. The code works around
  it by requesting `accept-encoding: gzip, deflate` only — but `buildDecompressChain` still
  supports `br`, so an origin that returns brotli regardless still hits the bad decoder. It is
  contained (every stage has an `error` handler because `.pipe()` does not forward errors, so a
  mid-chain failure becomes `FETCH_ERROR` instead of an unhandled event that kills the process),
  but the containment is the only thing between that origin and a crashed worker.
- Safe modification: never remove a per-stage `error` listener in `readBodyBounded`; never widen
  `accept-encoding` to include `br` without first re-verifying on the exact pinned Bun patch
  version; keep the regression test at `packages/fetch/src/__tests__/readbody-error.test.ts`.
- Test coverage: good for this specific path (`readbody-error.test.ts`, `decompression.test.ts`,
  `size.test.ts`), but all against synthetic streams — no real-origin brotli fixture.

**Undici-instead-of-`fetch` IP pinning:**
- Files: `packages/fetch/src/safe-fetcher.ts` (lines 16-17), `packages/fetch/src/dns-resolve.ts`,
  `packages/fetch/src/ip-validator.ts`.
- Why fragile: the whole SSRF guard depends on using undici's `request` with a custom connect
  `lookup` — Bun's global `fetch` breaks HTTPS with a custom lookup (Bun issue #27890). Anyone
  "simplifying" this back to `fetch` silently removes IP pinning while all tests still pass
  against non-TLS mocks.
- Safe modification: treat "uses undici, not global fetch" as a load-bearing invariant and
  comment it at every call site; add a test asserting the dispatcher carries a custom lookup.
- Test coverage: `redirect.test.ts`, `ip-validator.test.ts`, `safe-fetcher.test.ts` — but driven
  through a `testDispatcher` seam, which is exactly the path that bypasses the pinning.

**Coolify role dispatch via `GEO_ROLE`:**
- Files: `scripts/docker-entrypoint.sh`, `Dockerfile`.
- Why fragile: the original design selected the role by per-resource start command; Coolify 4.1.1
  ignores start-command overrides for the Dockerfile build pack (commit `c2e1c39`), so the role is
  now an env var. A resource created without `GEO_ROLE` silently falls through to `api|*)` and
  starts a second API instead of the worker/cron it was meant to be — with no error, and a
  healthy-looking container.
- Safe modification: make the default explicit rather than a fallthrough — require `GEO_ROLE` to
  be one of the three and exit non-zero on anything else, keeping `api` only for a literal
  `GEO_ROLE=api` or unset-with-warning. Log the resolved role at startup.
- Test coverage: none — the entrypoint is a shell script with no test.

**Migrations need a dedicated `max:1` connection:**
- Files: `packages/db/src/migrate.ts`, `packages/db/src/client.ts`.
- Why fragile: postgres.js forbids manual `BEGIN` over a pool (commit `11076ef`), so the migration
  runner must build its own single-connection client. Reusing the shared pool client here
  reintroduces the failure, and the symptom (a mid-migration error) is far from the cause.
- Safe modification: keep the migration client construction inside `migrate.ts`; never accept a
  shared `sql` handle as a parameter.
- Test coverage: `packages/db/src/__tests__/migrate.test.ts` and `concurrency.test.ts` run against
  PGlite, not real Postgres — the pool/`BEGIN` interaction that caused the bug is not reproduced.

## Scaling Limits

**Single-queue, lease-based worker with no visible concurrency knob:**
- Current capacity: throughput is bounded by (fetch time + model scoring time) per job across
  however many worker containers are running.
- Limit: model scoring dominates; CLI mode adds process-spawn cost per job. Scaling is horizontal
  only (more Coolify worker resources), and each additional worker needs its own env including the
  subscription token.
- Scaling path: content-hash caching first (largest win), then in-process concurrency within one
  worker, then horizontal.

**Postgres is both the queue and the datastore:**
- Current capacity: fine at current volume; the queue tests exercise lease/requeue behavior
  (`packages/db/src/__tests__/queue.test.ts`, `requeue.test.ts`, `lifecycle.test.ts`).
- Limit: high-frequency lease polling against the same table will contend as worker count grows.
- Scaling path: `LISTEN/NOTIFY`-driven wakeup instead of polling before reaching for a broker.

## Dependencies at Risk

**`oven/bun:1.3.1-slim` pinned base + Bun-specific bugs:**
- Risk: two separate Bun defects are already worked around in `packages/fetch` (brotli decoder,
  custom-lookup HTTPS). The pin protects against regression but also means Bun fixes are not
  picked up, and a future bump must re-validate both workarounds.
- Impact: a careless base-image bump can either resurrect the crash or leave dead workarounds that
  suppress brotli for no reason.
- Migration plan: on any Bun bump, run the fetch package suite first and explicitly re-test a real
  brotli origin before touching `accept-encoding`.

**Claude Code CLI installed with `ARG CLAUDE_CODE_VERSION=latest`:**
- Risk: the runtime stage runs `npm install -g @anthropic-ai/claude-code@latest` by default, so
  the CLI version is whatever exists at build time. The CLI's `stream-json` output format has
  historically shifted between versions, and `cli-scorer.ts` scans stdout for the
  `{type:"result",subtype:"success"}` line.
- Impact: a CLI release that changes that envelope breaks all subscription-mode scoring at the
  next image build, with no repo change.
- Migration plan: pin `CLAUDE_CODE_VERSION` to an exact version in the Dockerfile default (the
  build-arg override already exists) and bump it deliberately.

**NodeSource Node 22 installed via piped `curl | bash` in the image:**
- Risk: the runtime stage pipes a remote setup script into `bash` as root at build time —
  unpinned, unverified, and a supply-chain dependency on `deb.nodesource.com`.
- Impact: build breakage or worse if that endpoint changes; no reproducibility.
- Migration plan: install Node from a pinned `.deb` with a checksum, or drop Node entirely if the
  CLI can run under Bun.

## Missing Critical Features

**No webhook signature contract** — see Security. Consumers currently must trust any POST to their
callback URL.

**No API rate limiting / quota** — see Security.

**No score-result caching** — see Performance; every re-audit is a full-price model call.

**No unified entrypoint across the Python and TypeScript halves** — a user of the `skills/` path
gets a different scoring implementation than an API consumer, and nothing reconciles them.

## Test Coverage Gaps

**`scripts/docker-entrypoint.sh` role dispatch — untested:**
- What's not tested: the `GEO_ROLE` case statement, including the unset/unknown fallthrough to
  `api`.
- Files: `scripts/docker-entrypoint.sh`.
- Risk: a misconfigured Coolify resource silently runs the wrong role and looks healthy — exactly
  the class of failure that produced commits `c2e1c39`, `880ef81`, `6d5ff5a`.
- Priority: High.

**Real-Postgres behavior — only PGlite is exercised:**
- What's not tested: pool semantics, advisory locks under real concurrency, and the manual-`BEGIN`
  restriction that caused `11076ef`.
- Files: `packages/db/src/__tests__/*` (all via `pglite-executor.ts`),
  `packages/api/src/__tests__/pglite-helper.ts`.
- Risk: DB bugs only reproduce in production.
- Priority: High.

**The Python half is effectively untested:**
- What's not tested: everything except SSR fetch — one test file exists
  (`tests/test_fetch_page_ssr.py`) for ~1,700 lines of Python across five scripts plus the Flask
  app.
- Files: `scripts/citability_scorer.py`, `scripts/brand_scanner.py`,
  `scripts/llmstxt_generator.py`, `scripts/crm_dashboard.py`, `scripts/webapp/app.py`.
- Risk: silent scoring drift from the TypeScript implementation, unnoticed.
- Priority: Medium (High if the Python path stays user-facing).

**CLI scoring is tested only through the injected spawn seam:**
- What's not tested: the real `claude` subprocess — actual `stream-json` envelope parsing against
  a live CLI version, process-group kill on POSIX, and the Windows kill fallback.
- Files: `packages/worker/src/cli-scorer.ts`, `packages/worker/src/__tests__/cli-scorer.test.ts`.
- Risk: a CLI output-format change passes CI and fails only in production.
- Priority: High (compounded by the unpinned `CLAUDE_CODE_VERSION`).

**No end-to-end deploy smoke test in-repo:**
- What's not tested: the three roles actually starting from the built image and reaching a healthy
  state; `scripts/deploy-verify.sh` and `scripts/worker-healthcheck.sh` exist but are not wired
  into any automated gate.
- Files: `scripts/deploy-verify.sh`, `scripts/worker-healthcheck.sh`, `Dockerfile`.
- Risk: the last five commits before HEAD were all deploy-only fixes (`wget`, `curl`, DTS race,
  `examples/package.json`, role dispatch) — each found in production, none catchable by the unit
  suites.
- Priority: High.

## Deployment Risk

The deployment path is the least-covered and most-recently-broken part of this repo. Five of the
last ten commits are Docker/Coolify fixes discovered only at deploy time. The specific risks:

- Role selection is a silent-fallthrough env var (`GEO_ROLE`) on a platform that ignores
  start-command overrides.
- Build order is a hand-maintained `RUN` chain with a known DTS race behind it.
- Health checks depend on `curl`/`wget` being present in a slim image — twice fixed by hand.
- Migrations run as a separate pre-deploy one-shot with their own connection rules.
- The runtime image pulls two unpinned remote artifacts at build time (NodeSource script,
  `claude-code@latest`).

Any change to `Dockerfile` or `scripts/docker-entrypoint.sh` should be gated on an actual image
build plus a three-role start smoke test, not on the unit suites.

---

*Concerns audit: 2026-07-24*
