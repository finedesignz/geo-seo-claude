# Phase 7: Cron + Consumer Wiring - Context

**Gathered:** 2026-06-04
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers the **scheduled re-audit mechanism** and the **two consumer-facing
integration artifacts** that make `@geo/core` and the geo-api HTTP surface usable by the
two real consumers (`hyperoptimizedwebsites` / "HOW", and `ottolax`).

**In scope (this repo, geo-seo-claude):**
1. A **cron/scheduler component** (code + unit tests) that, on a schedule, POSTs `/audit`
   for each URL in a configured list, using a bearer token — re-audit automation (DEPLOY-02).
2. A **runnable `@geo/core` inline-import example + a test** proving HOW's consumption
   pattern: import `@geo/core` and call `checkRobots`/`detectRendering` with **no HTTP** to
   geo-api and **no network for the import itself** (CONS-01, success criterion 2).
3. A **Python client example + an HTTP-contract doc** for ottolax: `POST /audit` with
   `Authorization: Bearer`, poll `GET /audit/{job_id}`, parse `{status, score, findings}`
   (CONS-02, success criterion 3).
4. Consumer/integration docs under `docs/` (rule 21), with `/openapi.json` as the
   source of truth for the HTTP contract.

**Out of scope (explicitly):**
- **Editing the HOW or ottolax repos.** Those are SEPARATE repos
  (`C:\Users\artic\GitHub\hyperoptimizedwebsites`, `C:\Users\artic\GitHub\ottolax`); this
  session is confined to geo-seo-claude (rule 20). The actual wiring inside those repos is a
  **cross-repo follow-up** (see Deferred / Cross-Repo Gate). This phase ships the *contract +
  runnable example* that those repos integrate against — not the integration itself.
- **Live scheduled firing** (criterion 1 end-to-end) and **live ottolax HTTP round-trip**
  (criterion 3 end-to-end): both depend on the DEPLOYED geo-api service, which is
  **DEFERRED-LIVE** (Phase 6 operator/human gate not yet met). Code is built + unit-tested
  here; the live run defers to operator deploy (same pattern as Phase 6).
- A new HTTP endpoint for HOW. The whole point of CONS-01 is **no HTTP** for cheap checks —
  HOW imports the package inline. (HOW may *also* call the existing `/audit` for full audits;
  that path already exists from Phase 5 and needs no new code.)

**What is fully provable NOW (no deploy):** criterion 2 — `@geo/core` inline import is a pure
package import; a vitest test imports it and runs `checkRobots`/`detectRendering` with an
injected `Fetcher` (no real network) and asserts structured results.

</domain>

<decisions>
## Decisions (auto-mode: recommended option chosen for each gray area)

All decisions taken autonomously (`--auto`), consistent with the standing ground truth.

### D-1 — Cron mechanism: dedicated `@geo/cron` script in the existing image, NOT a separate image
**Decision:** Add a small cron entry point (e.g. `packages/cron/` or a `scripts/cron-reaudit.ts`
runnable in the existing Docker image) that reads a URL list + schedule config from env and
POSTs `/audit` per URL with a bearer token. Run it as **Coolify's scheduled-task / cron
feature** (a third run target off the SAME image — mirrors the Phase 6 "one image, multiple
run targets" pattern: api = default CMD, worker = start-command override), NOT a long-lived
in-container `setInterval` loop.
**Rationale:** Reuses the single multi-stage image already built in Phase 6 (`06-DEPLOY-RECORD`:
"one image, three run targets"). Coolify-native scheduled tasks (rule 17) give crash-isolation,
log capture, and a real cron expression without a babysat daemon. A one-shot "fire all
configured URLs then exit" process is simpler to unit-test (no timer to mock) and matches the
worker's clean-exit discipline (rule 23). The in-container loop is the fallback only if Coolify
scheduled-tasks are unavailable for this resource.

### D-2 — URL-list + schedule config source: env-driven (`CRON_TARGET_URLS` + `CRON_SCHEDULE`), 12-factor
**Decision:** The configured site list comes from an env var (newline/comma-separated
`CRON_TARGET_URLS`), the schedule from `CRON_SCHEDULE` (cron expression, owned by the Coolify
scheduled-task config), and auth from a `GEO_API_KEYS`-issued bearer token in env
(`CRON_API_TOKEN`) plus the target base URL (`GEO_API_BASE_URL`).
**Rationale:** Matches the existing 12-factor secrets posture (D-07 Phase 6: all secrets +
tunables from Coolify env, nothing baked in). No new config file format to invent; `.env.example`
already documents the pattern. A file-backed list is a possible future enhancement but env is
the simplest fit for an MVP list of sites.

### D-3 — Re-audit cadence vs dedup TTL: schedule cadence MUST exceed the 1h dedup window; NO force flag added
**Decision:** Do **not** add a `force`/`no_dedup` flag to `POST /audit` in this phase. The
re-audit `CRON_SCHEDULE` is constrained to fire **less frequently than the dedup window**
(`DEDUP_TTL_MS = 60 * 60 * 1000`, hardcoded in `packages/api/src/routes/audit-post.ts`) — i.e.
recommended default cadence ≥ daily, and documented as "must be > 1h". Within an hour, a repeat
POST for the same consumer+url correctly dedups to the existing job (by design).
**Rationale:** The API body schema today is exactly `{url, callback_url?}` — there is no force
flag, and adding one is a real API-surface change (new zod field, OpenAPI regen, auth/abuse
considerations) that is out of this phase's "wire the consumers" scope. Re-audits are
inherently periodic (daily/weekly), comfortably above 1h, so dedup never suppresses a legitimate
scheduled re-audit. Surgical (rule 11): no new code on the hot path. If a future phase needs
sub-hour forced re-audits, a `force` flag is the right follow-up — noted in Deferred.

### D-4 — Cron auth: a dedicated `GEO_API_KEYS` consumer entry for the cron caller
**Decision:** The cron process authenticates with its own bearer token mapped to a distinct
`consumer_id` (e.g. `cron`), supplied via `GEO_API_KEYS` (token:consumer_id) on the api side
and `CRON_API_TOKEN` on the cron side.
**Rationale:** Dedup and job ownership are **consumer-scoped** (audit-post.ts / audit-get.ts).
Giving cron its own consumer_id keeps its re-audit history cleanly attributable and isolated
from HOW/ottolax jobs, and reuses the exact existing auth path (no new auth code).

### D-5 — CONS-01 delivery: runnable in-repo example + test now; the publish/link step is the cross-repo action
**Decision:** Deliver an `examples/how-inline-usage.ts` (a runnable snippet that imports
`@geo/core` and calls `checkRobots` + `detectRendering` against an injected `Fetcher`, no
network) **plus** a vitest test asserting it works, **plus** a short doc section describing how
HOW depends on `@geo/core` (workspace path dep if co-located, or a published/git dep otherwise).
The actual `package.json` dependency wiring inside the HOW repo is the cross-repo follow-up.
**Rationale:** `@geo/core` is already zero-dep (Phase 1, no `node:` imports in `src/`), so the
import is pure and fully testable here with no deploy. This satisfies criterion 2 *now*. NOT
Titanium, NOT a new HTTP endpoint (CONS-01 is explicitly the no-HTTP path). Distribution method
(publish vs file/git dep) is documented but executed in HOW's repo.

### D-6 — CONS-02 delivery: Python client example + HTTP-contract doc now; ottolax repo wiring is cross-repo
**Decision:** Deliver `examples/ottolax-client.py` (a self-contained Python client: `POST /audit`
with `Authorization: Bearer`, poll `GET /audit/{job_id}` until terminal, parse
`{status, score, findings}` / `error_code`) **plus** `docs/consumers.md` (or similar) documenting
the contract, pointing at `/openapi.json` as source of truth. The ottolax bearer token is a
`GEO_API_KEYS` entry for the ottolax `consumer_id`.
**Rationale:** ottolax is Python and reaches the logic only via HTTP (PROJECT.md line 60). The
contract is fully knowable now from the existing Phase 5 routes (`{url, callback_url?}` →
`{job_id}`; poll → `{status, score?, findings?, error_code?}`). The example is testable for
*shape* but the live round-trip needs the deployed service → DEFERRED-LIVE. Actual ottolax repo
integration = cross-repo follow-up.

### D-7 — Testability split (what's proven now vs DEFERRED-LIVE)
**Decision:**
- **Criterion 2 (CONS-01):** PROVEN NOW — vitest import + call test, no network.
- **Criterion 1 (cron, DEPLOY-02):** CODE + UNIT-TESTED NOW — test the cron module by mocking
  the HTTP POST (or running it against the in-process Hono app via `app.request` + PGlite, the
  established api test pattern) and asserting it POSTs `/audit` per configured URL with the
  bearer header. **Live scheduled firing DEFERRED-LIVE.**
- **Criterion 3 (ottolax, CONS-02):** CLIENT CODE + CONTRACT NOW; the Python example's live
  round-trip is **DEFERRED-LIVE** (needs deployed service). Optionally smoke the example logic
  against a local/in-process server in CI if feasible; otherwise contract-doc + example only.
**Rationale:** Mirrors the Phase 6 DEFERRED-LIVE pattern (artifacts complete, live deploy gated
on operator). Keeps the phase shippable without blocking on the human deploy gate.

### D-8 — Cron HTTP client reuse
**Decision:** The cron caller uses a plain `fetch` POST to `${GEO_API_BASE_URL}/audit` (Bun's
global fetch) — it does NOT import `@geo/api` internals. Keep it a thin, dependency-light client
(it may live in the existing image but is logically a separate run target).
**Rationale:** Decouples cron from api internals; the contract is the public HTTP surface
(`/openapi.json`). Same client shape the ottolax example documents, just in TS.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap / Requirements / Project
- `.planning/ROADMAP.md` §"Phase 7: Cron + Consumer Wiring" — goal, mode (mvp), depends-on Phase 6, the 3 success criteria.
- `.planning/REQUIREMENTS.md` — **DEPLOY-02** (cron container re-audits a configured list on a schedule via `/audit`), **CONS-01** (HOW imports `@geo/core` inline + can call service for full audit), **CONS-02** (ottolax triggers on-demand audit via HTTP and reads result). Also DEPLOY-03 (env secrets), DEPLOY-04 (deploy verify) as constraints.
- `.planning/PROJECT.md` — consumer model (lines 5, 28, 36–38, 60, 77–78): HOW imports `@geo/core` inline, ottolax via HTTP; two committed consumers justify the network boundary.
- `.planning/STATE.md` — current position, project reference (stack, core value).

### `@geo/core` inline-import surface (CONS-01)
- `packages/core/src/index.ts` — the single public barrel. Relevant exports: `checkRobots`, `detectRendering`, `generateLlmsTxt`/`validateLlmsTxt`, `getSchemaTemplates`/`validateStructuredData`, `computeCitabilityScore`/`scorePassage`, `normalizeUrl`; types incl. `FetchResult`, `Fetcher`, `RobotsResult`, `RenderingResult`. Zero runtime deps, **no `node:` imports in `src/`** — import is pure/network-free.

### HTTP contract (cron + CONS-02)
- `packages/api/src/routes/audit-post.ts` — `POST /audit`: body `{ url, callback_url? }` → `{ job_id }`. **Consumer-scoped dedup**, `DEDUP_TTL_MS = 60*60*1000` (1h, hardcoded here). 400 invalid url / `ssrf_blocked` callback; 401 bad token. **No force flag exists.**
- `packages/api/src/routes/audit-get.ts` — `GET /audit/{job_id}`: ownership-scoped → `{ status: queued|running|done|failed, score?, findings?, error_code? }`. 404 if not found or not owned (no existence leak).
- `packages/api/src/middleware/auth.ts` — bearer auth: `GEO_API_KEYS` = comma-separated `token:consumer_id`; resolved `consumer_id` set on context; EXEMPT = `/healthz`, `/openapi.json`, `/docs`; constant-time compare; header never logged.
- `packages/api/src/app.ts` — app wiring (`AppDeps`, `AppVariables`, route registration); `/openapi.json` + `/docs` are the rule-21 contract surface.
- `packages/api/src/__tests__/audit-post.test.ts`, `audit-get.test.ts`, `pglite-helper.ts` — the established test pattern: `app.request(...)` against the in-process Hono app + PGlite (use this to unit-test the cron POST flow).

### Deploy / image / run targets (cron run target)
- `docs/deploy.md` — Coolify deploy runbook: "one image, three run targets"; api (default CMD, port 8080, `/healthz`), worker (start-command override, exec health). The cron becomes an additional scheduled-task run target off the same image. (No cron section yet — this phase adds one.)
- `.planning/phases/06-*/06-DEPLOY-RECORD.md` + `06-CONTEXT.md` — DEFERRED-LIVE pattern, human-gate steps, D-07 (all secrets/tunables from Coolify env, expand `.env.example`), multi-run-target-off-one-image strategy.
- `packages/worker/src/main.ts` / `worker.ts` — env-driven config + clean-exit + SIGTERM patterns to mirror for the cron entry point.

### Standing rules (global `~/.claude/CLAUDE.md`)
- **Rule 10** — delegate each unit to a specialist; orchestrator coordinates.
- **Rule 17** — Postgres on Coolify; use Coolify scheduled-task/cron feature over a hand-rolled daemon.
- **Rule 19** — fresh branch per phase (work continues on `phase-01-...` per the session brief; planning may branch per orchestrator).
- **Rule 20** — repo confinement: do NOT edit HOW or ottolax repos from this session; cross-repo edits are a separate repo-scoped task.
- **Rule 21** — every app exposes `/openapi.json` + `/docs`; consumer docs under `docs/`; `/openapi.json` is the HTTP-contract source of truth.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/core` public barrel (`src/index.ts`): zero-dep, pure import. Directly usable as the CONS-01 inline example target (`checkRobots`, `detectRendering`). The `Fetcher`/`FetchResult` seam lets the example/test inject a fake fetch — no real network.
- `packages/api` in-process test harness (`app.request` + `pglite-helper.ts`): the exact pattern to unit-test the cron POST loop without a live server or real Postgres.
- The Phase 6 multi-stage Dockerfile + "one image, N run targets" model: the cron is a new run target (Coolify scheduled task), no new image.
- Worker env/config + graceful-exit patterns (`worker/src/main.ts`): template for a clean-exiting cron one-shot.

### Established Patterns
- **Consumer-scoped dedup + ownership** (audit-post/audit-get): cron gets its own `consumer_id` so re-audit history is isolated; 1h dedup TTL is hardcoded — cron cadence must exceed it (D-3).
- **Bearer auth via `GEO_API_KEYS`** (`token:consumer_id`): cron + ottolax each get an entry; EXEMPT list keeps `/healthz` + docs public.
- **OpenAPI-first routes** (`createRoute` + zod, never `app.post`): no new endpoints in this phase, but the `/openapi.json` they emit is the contract the consumer artifacts document.
- **12-factor env config** (D-07 Phase 6): all cron tunables (`CRON_TARGET_URLS`, `CRON_SCHEDULE`, `CRON_API_TOKEN`, `GEO_API_BASE_URL`) from env; expand `.env.example`.

### Integration Points
- **Cron → api:** plain `fetch` POST to `${GEO_API_BASE_URL}/audit` with `Authorization: Bearer ${CRON_API_TOKEN}`; results land in audit history (Postgres) and are visible via `GET /audit/{id}` / list route.
- **HOW → `@geo/core`:** direct package import (workspace/published dep). No HTTP. (HOW may separately call `/audit` for full audits — existing path.)
- **ottolax → api:** HTTP only — `POST /audit` then poll `GET /audit/{id}`; example in `examples/ottolax-client.py`, contract in `docs/`.

</code_context>

<specifics>
## Specific Ideas

- New artifacts (this repo): a cron entry point (`packages/cron/` or `scripts/cron-reaudit.ts`),
  `examples/how-inline-usage.ts` (+ test), `examples/ottolax-client.py`, a `docs/consumers.md`
  (consumer integration + cron config), and a cron section appended to `docs/deploy.md`.
- Keep `/openapi.json` authoritative; the Python example and consumer doc reference it rather
  than re-specifying the schema.
- Cron one-shot semantics: "fire all configured URLs, then exit" (Coolify scheduled task), not a
  resident loop — easiest to unit-test and aligns with clean-exit (rule 23).

</specifics>

<deferred>
## Deferred Ideas / Cross-Repo & Live Gate

### HUMAN / OPERATOR GATE — DEFERRED-LIVE (depends on deployed geo-api)
The following require the Phase 6 operator deploy (Coolify provision + env secrets) which is
**not yet met**. Build + unit-test the code now; the live confirmations defer:
- **Criterion 1 live:** the Coolify scheduled task actually firing on `CRON_SCHEDULE` and the
  re-audit jobs appearing in audit history.
- **Criterion 3 live:** the ottolax Python example completing a real `POST /audit` → poll →
  `{score, findings}` round-trip against the deployed service.
- Operator actions: register the cron as a Coolify scheduled task off the existing image; add
  `GEO_API_KEYS` entries for the `cron` and `ottolax` consumers; set `CRON_*` + `GEO_API_BASE_URL`
  env. Bundle into the same post-deploy verify script (rule 14).

### CROSS-REPO FOLLOW-UP (separate repo-scoped sessions; NOT done in geo-seo-claude commits)
- **HOW repo** (`C:\Users\artic\GitHub\hyperoptimizedwebsites`): add the `@geo/core` dependency
  (workspace/published/git dep) and call `checkRobots`/`detectRendering` inline per the
  `examples/how-inline-usage.ts` contract. Session is confined to geo-seo-claude (rule 20) — this
  edit is out of scope here.
- **ottolax repo** (`C:\Users\artic\GitHub\ottolax`): integrate the Python client per
  `examples/ottolax-client.py` + `docs/consumers.md`, using its `GEO_API_KEYS` bearer token.

### Considered but deferred to a future phase
- A `force` / `no_dedup` flag on `POST /audit` for sub-hour forced re-audits (D-3). Not needed
  while re-audit cadence > 1h; an API-surface change better scoped to its own phase.
- File-backed (vs env) cron target list (D-2) — env suffices for the MVP site list.

</deferred>

---

*Phase: 07-cron-consumer-wiring*
*Context gathered: 2026-06-04*
