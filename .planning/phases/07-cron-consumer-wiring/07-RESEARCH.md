# Phase 7: Cron + Consumer Wiring - Research

**Researched:** 2026-06-04
**Domain:** Bun one-shot scheduled job + cross-consumer integration artifacts (TS inline import + Python HTTP client) for the geo-api monorepo
**Confidence:** HIGH (codebase facts verified by direct read) / MEDIUM (Coolify scheduled-task behaviour — verified via WebSearch + GitHub discussions, official docs page not directly fetchable this session)

## Summary

Phase 7 adds a third run target to the existing single Docker image — a **one-shot cron entry** that reads `CRON_TARGET_URLS`, POSTs `/audit` per URL with a bearer token, logs each result, and exits — plus two consumer artifacts (a runnable `@geo/core` inline-import example + test, and a stdlib-only Python HTTP client) and consumer docs. All decisions D-1..D-8 are LOCKED in CONTEXT.md; this research is HOW-only.

The cron entry mirrors the worker's structure exactly: a new `packages/cron/` workspace package with `src/main.ts` + tsup producing `dist/main.js`, run via `bun packages/cron/dist/main.js`, invoked by a **Coolify scheduled task** (cron expression in Coolify config, `docker exec` into the service container — see D-1). It is a thin `fetch` client against the public HTTP surface (D-8) — it does NOT import `@geo/api` internals at runtime. The live scheduled firing and the live ottolax round-trip are **DEFERRED-LIVE** (Phase 6 operator deploy gate not yet met).

**Primary recommendation:** Create `packages/cron/` (mirror `packages/worker/`: `package.json` with `bin`, `tsup.config.ts` entry `["src/index.ts","src/main.ts"]`, `src/env.ts` fail-fast, `src/cron.ts` pure loop, `src/main.ts` thin wiring). Unit-test the loop against the in-process Hono app via `createApp` + `app.request` + the Phase-5 PGlite helper (highest fidelity — D-7). Ship `examples/how-inline-usage.ts` (+vitest), `examples/ottolax-client.py` (stdlib `urllib` only), `docs/consumers.md`, and a cron section in `docs/deploy.md`. Add `cron`/`ottolax` consumer entries to `GEO_API_KEYS` (operator action, DEFERRED-LIVE).

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-1** — Cron = dedicated script in the EXISTING image, run as a Coolify scheduled task (third run target off one image, like worker). One-shot "fire all URLs then exit", NOT an in-container `setInterval` loop. In-container loop is fallback only if Coolify scheduled tasks unavailable.
- **D-2** — Config is env-driven, 12-factor: `CRON_TARGET_URLS` (newline/comma list), `CRON_SCHEDULE` (cron expr, owned by Coolify task config), `CRON_API_TOKEN` (bearer), `GEO_API_BASE_URL`.
- **D-3** — Schedule cadence MUST exceed the 1h dedup window (`DEDUP_TTL_MS = 60*60*1000`). NO `force`/`no_dedup` flag added to `POST /audit` this phase. Recommended cadence ≥ daily, documented as "must be > 1h".
- **D-4** — Cron authenticates with its own bearer mapped to a distinct `consumer_id` (`cron`) via `GEO_API_KEYS`; isolated re-audit history.
- **D-5** — CONS-01: ship `examples/how-inline-usage.ts` (imports `@geo/core`, calls `checkRobots`+`detectRendering` with an injected `Fetcher`, no network) + vitest test + doc on how HOW depends on `@geo/core`. Actual HOW package.json wiring = cross-repo follow-up.
- **D-6** — CONS-02: ship `examples/ottolax-client.py` (POST /audit Bearer, poll GET /audit/{id} to terminal, parse `{status,score,findings}`/`error_code`) + `docs/consumers.md` pointing at `/openapi.json`. ottolax token = `GEO_API_KEYS` entry. ottolax repo wiring = cross-repo follow-up.
- **D-7** — Testability split: CONS-01 PROVEN NOW (vitest, no network); cron CODE+UNIT-TESTED NOW (test against in-process Hono app via `app.request`+PGlite, or mock POST), live firing DEFERRED-LIVE; CONS-02 client+contract NOW, live round-trip DEFERRED-LIVE.
- **D-8** — Cron client uses plain `fetch` POST to `${GEO_API_BASE_URL}/audit` (Bun global fetch); does NOT import `@geo/api` internals. Thin dependency-light client.

### Claude's Discretion
- Exact file layout (`packages/cron/` vs `scripts/cron-reaudit.ts`) — research recommends `packages/cron/` (below).
- `CRON_TARGET_URLS` parse format details, validation strictness.
- Cron test fidelity (in-process app vs mock fetch) — research recommends in-process.
- Python client: stdlib `urllib` vs `requests` — research recommends stdlib.

### Deferred Ideas (OUT OF SCOPE)
- Editing HOW (`hyperoptimizedwebsites`) or ottolax repos — rule 20, separate repo-scoped sessions.
- Live scheduled firing + live ottolax HTTP round-trip — DEFERRED-LIVE (needs deployed geo-api).
- A new HTTP endpoint for HOW (CONS-01 is the no-HTTP path).
- A `force`/`no_dedup` flag on POST /audit (future phase).
- File-backed (vs env) cron target list (future enhancement).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DEPLOY-02 | Cron container re-audits a configured list on a schedule via `/audit` | `packages/cron/` one-shot + Coolify scheduled task (Q1, Q2); cadence>1h constraint (Q3); env config (Q4) |
| CONS-01 | HOW imports `@geo/core` inline + can call service for full audit | `examples/how-inline-usage.ts` + vitest, no-network proof (Q6); `@geo/core` publishability (Q6) |
| CONS-02 | ottolax triggers on-demand audit via HTTP and reads result | `examples/ottolax-client.py` stdlib client + `docs/consumers.md` (Q7); HTTP contract from verified routes |
| DEPLOY-03 | Env secrets (constraint) | `CRON_API_TOKEN`/`GEO_API_KEYS` from Coolify env, never baked (Q4, Q8) |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Scheduled re-audit firing | Cron run target (one-shot off image) | Coolify scheduler | Coolify owns the cron clock; the container only fires-then-exits |
| Audit enqueue + dedup | API (`POST /audit`) | — | Cron is just another HTTP consumer; dedup/ownership already consumer-scoped |
| Inline cheap checks (robots/rendering) | Consumer process (HOW) via `@geo/core` | — | CONS-01 is explicitly the no-HTTP path; pure package import |
| On-demand audit + result read | API (`POST`/`GET /audit`) | ottolax client | ottolax reaches logic only via HTTP (Python) |

## Standard Stack

### Core (all already in-repo — NO new external packages)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun runtime | 1.3.1 (image `oven/bun:1.3.1-slim`) | Cron entry runtime + global `fetch` | [VERIFIED: Dockerfile] Same pinned image; cron is a run target, no new image |
| tsup | 8.5.1 | Build `packages/cron` → `dist/main.js` | [VERIFIED: worker/api package.json] Established monorepo build tool |
| vitest | 4.1.8 | Cron unit test + CONS-01 example test | [VERIFIED: package.json] Repo test runner |
| `@geo/api` `createApp` | workspace:* | In-process test target for cron loop (devDep of `@geo/cron` tests only) | [VERIFIED: app.ts L45 `export function createApp(deps: AppDeps)`] Phase-5 harness pattern |
| `@geo/core` | 0.1.0 workspace:* | CONS-01 inline-import target | [VERIFIED: core/package.json] Zero runtime deps, pure import |
| Python stdlib `urllib.request`/`json` | CPython 3.x | ottolax client example | [ASSUMED] Portable, zero-dep; no `requests` install needed |

**No external packages are installed in this phase.** The cron runtime uses Bun's global `fetch` (D-8). The Python example uses stdlib only. **Package Legitimacy Audit is therefore N/A** — no `npm install`/`pip install` of third-party packages.

### `@geo/cron` package.json (recommended — mirror worker)
```jsonc
{
  "name": "@geo/cron",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist"],
  "bin": { "geo-cron": "./dist/main.js" },
  "scripts": { "build": "tsup", "test": "vitest" },
  "dependencies": {},                       // D-8: plain fetch, no @geo/api at runtime
  "devDependencies": {
    "@geo/api": "workspace:*",              // test-only: createApp for in-process target
    "@geo/db": "workspace:*",               // test-only: DAL assertions
    "@electric-sql/pglite": "0.5.1",        // test-only: in-memory DB
    "tsup": "8.5.1", "typescript": "6.0.3",
    "vitest": "4.1.8", "@types/node": "25.9.1"
  }
}
```
`tsup.config.ts` — copy worker's verbatim: `entry: ["src/index.ts","src/main.ts"]`, `format: ["esm","cjs"]`, `dts:true`, `clean:true`, `target:"es2022"`.

**Dockerfile change:** add one line in the `deps` stage manifest-copy block (so the install layer sees it):
```dockerfile
COPY packages/cron/package.json ./packages/cron/package.json
```
The `build` stage already runs `bun run --filter '*' build` (builds all packages incl. the new one) and the `runtime` stage already copies `--from=build /app/packages`, so `packages/cron/dist/main.js` ships automatically. No new stage, no new CMD.

## Architecture Patterns

### System Architecture Diagram
```
Coolify scheduler (cron expr = CRON_SCHEDULE, UTC)
        │  on tick
        ▼
docker exec → one-shot container off the EXISTING image
   `bun packages/cron/dist/main.js`
        │
        │ 1. assertEnv() fail-fast (CRON_TARGET_URLS, CRON_API_TOKEN, GEO_API_BASE_URL)
        │ 2. parse CRON_TARGET_URLS → string[]
        ▼
   for each url:  fetch POST ${GEO_API_BASE_URL}/audit
        │           Authorization: Bearer ${CRON_API_TOKEN}
        │           body {url}
        ▼
   geo-api  POST /audit  (consumer_id="cron")
        │   normalize → sha256 hash → consumer-scoped dedup (1h TTL)
        │   cadence > 1h ⇒ NOT deduped ⇒ insert new job → {job_id}
        ▼
   Postgres audit_jobs (worker picks up async)
        │
   cron logs {url → job_id | error}, accumulates failures
        ▼
   process.exit(0 if all enqueued | 1 if any failed)   ← clean exit (rule 23)


CONS-01 (no network):  HOW process ── import @geo/core ──▶ checkRobots(url, injectedFetcher)
                                                          detectRendering(html)
CONS-02 (HTTP):        ottolax.py ── POST /audit ─▶ poll GET /audit/{id} ─▶ {status,score,findings}
```

### Recommended Project Structure
```
packages/cron/
├── package.json          # @geo/cron, bin geo-cron, no runtime deps
├── tsup.config.ts        # copy of worker's
└── src/
    ├── index.ts          # barrel: export { runCron } (for tests)
    ├── env.ts            # assertEnv() + parseTargetUrls() fail-fast
    ├── cron.ts           # runCron({ baseUrl, token, urls, fetchImpl }) — pure, injectable fetch
    └── main.ts           # thin: read env → runCron → exit code
examples/
├── how-inline-usage.ts   # CONS-01 runnable inline import
├── how-inline-usage.test.ts  # vitest: imports @geo/core, asserts offline run
└── ottolax-client.py     # CONS-02 stdlib Python client
docs/
├── consumers.md          # consumer integration + cron config + contract (→ /openapi.json)
└── deploy.md             # append "Cron / scheduled re-audit" run-target section
```

### Pattern 1: One-shot cron loop with injectable fetch (testability seam)
```ts
// packages/cron/src/cron.ts
export interface CronDeps {
  baseUrl: string;
  token: string;
  urls: string[];
  fetchImpl?: typeof fetch;   // default = global fetch (Bun); tests inject app.request
}

export interface CronResult { url: string; jobId?: string; error?: string; }

export async function runCron(deps: CronDeps): Promise<CronResult[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const results: CronResult[] = [];
  for (const url of deps.urls) {
    try {
      const res = await doFetch(`${deps.baseUrl}/audit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.token}`,   // header value NEVER logged
        },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        results.push({ url, error: `http_${res.status}` });
        continue;                                   // partial-failure: keep going (Pitfall 3)
      }
      const json = (await res.json()) as { job_id: string };
      results.push({ url, jobId: json.job_id });
      console.log(`[cron] enqueued ${url} -> ${json.job_id}`);
    } catch (err) {
      results.push({ url, error: String(err) });
      console.error(`[cron] FAILED ${url}: ${err}`);
    }
  }
  return results;
}
```
```ts
// packages/cron/src/main.ts
import { assertEnv, parseTargetUrls } from "./env.js";
import { runCron } from "./cron.js";
const env = assertEnv();                            // throws if missing (fail-fast, mirrors worker)
const urls = parseTargetUrls(env.CRON_TARGET_URLS);
const results = await runCron({ baseUrl: env.GEO_API_BASE_URL, token: env.CRON_API_TOKEN, urls });
const failed = results.filter((r) => r.error);
console.log(`[cron] done: ${results.length - failed.length} enqueued, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);            // non-zero ⇒ Coolify marks task failed
```
**Why:** the `fetchImpl` seam lets the test pass `app.request` (in-process Hono) with zero network — same seam discipline as `@geo/core`'s `Fetcher` (D-7). Plain `fetch` default keeps the runtime dep-light (D-8).

### Pattern 2: `CRON_TARGET_URLS` parsing (D-2) — tolerant of comma OR newline
```ts
// packages/cron/src/env.ts
export function parseTargetUrls(raw: string): string[] {
  const urls = raw
    .split(/[\n,]/)            // accept newline- OR comma-separated (D-2)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (urls.length === 0) throw new Error("[cron] CRON_TARGET_URLS is empty after parsing");
  for (const u of urls) {
    try { new URL(u); }        // validate each up front (fail-fast before any POST)
    catch { throw new Error(`[cron] CRON_TARGET_URLS contains invalid URL: ${u}`); }
  }
  return urls;
}
export function assertEnv() {
  const req = ["CRON_TARGET_URLS", "CRON_API_TOKEN", "GEO_API_BASE_URL"] as const;
  for (const k of req) if (!process.env[k]) throw new Error(`[cron] ${k} is required`);
  return {
    CRON_TARGET_URLS: process.env.CRON_TARGET_URLS!,
    CRON_API_TOKEN: process.env.CRON_API_TOKEN!,
    GEO_API_BASE_URL: process.env.GEO_API_BASE_URL!.replace(/\/$/, ""), // strip trailing slash
  };
}
```
Recommend comma/newline (NOT JSON) — simplest, matches D-2 wording ("newline/comma-separated"), no quoting hazards in Coolify env UI. JSON noted as a future option if URLs need per-entry metadata.

### Pattern 3: CONS-01 inline import (no network)
```ts
// examples/how-inline-usage.ts — runnable: `bun examples/how-inline-usage.ts`
import { checkRobots, detectRendering, type Fetcher, type FetchResult } from "@geo/core";

// HOW already has page HTML + robots.txt in hand (it crawls); inject a Fetcher that
// returns what it already fetched — @geo/core does ZERO network I/O (the seam, types.ts).
const fakeFetcher: Fetcher = async (url): Promise<FetchResult> => ({
  url, status: 200, headers: {}, redirectChain: [],
  body: "User-agent: GPTBot\nDisallow: /private\n",
});

export async function inlineGeoChecks(siteUrl: string, html: string) {
  const robots = await checkRobots(siteUrl, fakeFetcher);   // RobotsResult: aiCrawlerStatus, sitemaps, errors
  const rendering = detectRendering(html);                  // RenderingResult: rendering 'ssr'|'csr'|'hybrid', confidence
  return { robots, rendering };
}

if (import.meta.main) {
  const out = await inlineGeoChecks("https://example.com", '<html><body><h1>Hi</h1></body></html>');
  console.log(JSON.stringify(out, null, 2));
}
```
```ts
// examples/how-inline-usage.test.ts
import { test, expect } from "vitest";
import { inlineGeoChecks } from "./how-inline-usage.js";
test("CONS-01: @geo/core runs inline with no network", async () => {
  const { robots, rendering } = await inlineGeoChecks("https://example.com", "<html><body>hello</body></html>");
  expect(robots.aiCrawlerStatus.GPTBot).toBeDefined();    // BLOCKED for /private
  expect(["ssr", "csr", "hybrid"]).toContain(rendering.rendering);
});
```
**Verified signatures** [VERIFIED: codebase read 2026-06-04]:
- `checkRobots(siteUrl: string, fetcher: Fetcher): Promise<RobotsResult>` (robots.ts L181)
- `detectRendering(html: string): RenderingResult` (rendering.ts L104, synchronous)
- `normalizeUrl(input: string): { url: string; errors: string[] }` (url.ts L10)
- `Fetcher = (url: string) => Promise<FetchResult>`; `FetchResult = {url,status,headers,body,redirectChain,error?}` (types.ts)
- `RobotsResult = {url,exists,content,aiCrawlerStatus,sitemaps,errors}`; `aiCrawlerStatus` keyed by `GPTBot|ClaudeBot|PerplexityBot|GoogleBot|BingBot`
- `RenderingResult = {rendering:'ssr'|'csr'|'hybrid',confidence,signals,wordCount,scriptCount,errors}`

### Pattern 4: CONS-02 Python client (stdlib only — D-6)
```python
# examples/ottolax-client.py — `python examples/ottolax-client.py https://example.com`
import json, os, sys, time, urllib.request, urllib.error

BASE = os.environ.get("GEO_API_BASE_URL", "http://localhost:8080").rstrip("/")
TOKEN = os.environ["GEO_API_TOKEN"]   # a GEO_API_KEYS bearer for the ottolax consumer

def _req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method,
                               headers={"Authorization": f"Bearer {TOKEN}",
                                        "Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=30) as resp:
        return resp.status, json.loads(resp.read() or "{}")

def submit(url):
    _, j = _req("POST", "/audit", {"url": url})          # -> {"job_id": "..."}
    return j["job_id"]

def poll(job_id, interval=3.0, timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        _, j = _req("GET", f"/audit/{job_id}")           # -> {status, score?, findings?, error_code?}
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(interval)
    raise TimeoutError(f"job {job_id} did not finish in {timeout}s")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
    jid = submit(target)
    print(f"submitted {target} -> {jid}", file=sys.stderr)
    result = poll(jid)
    if result["status"] == "done":
        print(json.dumps({"score": result.get("score"), "findings": result.get("findings")}, indent=2))
    else:
        print(f"audit failed: {result.get('error_code')}", file=sys.stderr); sys.exit(1)
```
**Verified contract** [VERIFIED: audit-post.ts / audit-get.ts read 2026-06-04]:
- `POST /audit` body `{url, callback_url?}` → `200 {job_id}` | `400 {error,message}` (`invalid_url`/`ssrf_blocked`) | `401`
- `GET /audit/{job_id}` → `200 {status: queued|running|done|failed, score?, findings?, error_code?}` | `401` | `404` (not found OR not owned — no existence leak)
- `score`+`findings` present ONLY when `status==done`; `error_code` ONLY when `status==failed`
- `findings` is an object (`z.record(z.string(), z.unknown())`)

### Pattern 5: Cron unit test against in-process app (D-7, highest fidelity)
```ts
// packages/cron/src/__tests__/cron.test.ts
import { test, expect } from "vitest";
import { createApp } from "@geo/api";                 // app.ts L45 (verified export)
import { makeTestDal } from "../../../api/src/__tests__/pglite-helper.js"; // Phase-5 harness
import { runCron } from "../cron.js";

test("DEPLOY-02: cron POSTs /audit per URL as the cron consumer", async () => {
  const { dal } = await makeTestDal();
  const apiKeys = new Map([["cron-token", "cron"]]);  // GEO_API_KEYS shape: token->consumer_id
  const app = createApp({ dal, fetcher: /* fake */ undefined as any, apiKeys, /* callbackResolver */ });
  const fetchImpl: typeof fetch = (input, init) =>
    app.request(input as string, init as RequestInit);     // in-process, no network

  const urls = ["https://a.example", "https://b.example"];
  const results = await runCron({ baseUrl: "", token: "cron-token", urls, fetchImpl });

  expect(results.every((r) => r.jobId)).toBe(true);   // each enqueued
  // assert jobs landed scoped to consumer_id="cron" via dal (ownership)
});
```
**Note** the `app.request` base path: pass `baseUrl: ""` so the POST URL is just `/audit` (Hono resolves the route from the path). Confirm `createApp`'s full `AppDeps` shape when implementing (`dal`, `fetcher`, `apiKeys`, plus `callbackResolver` — see app.ts L25-30+). Fallback per D-7 is a mocked `fetchImpl` asserting call count + Bearer header — lower fidelity, use only if the in-process wiring is awkward.

### Anti-Patterns to Avoid
- **In-container `setInterval` daemon** — D-1 forbids; loses crash-isolation + clean-exit, needs a babysat process + timer mocking.
- **Importing `@geo/api` route internals into the cron runtime** — D-8 forbids; couples cron to internal types. `@geo/api` is test-only devDep.
- **Logging the Authorization header / token** — never. Log job_id + url only (Pitfall 8 / auth.ts discipline).
- **`force` flag on POST /audit** — D-3 forbids this phase.
- **Re-specifying the HTTP schema in docs** — `docs/consumers.md` must point at `/openapi.json` as source of truth (rule 21).

## Coolify Scheduled Tasks (Q2)

[VERIFIED: WebSearch + coollabsio/coolify GitHub discussions #3152, #2772, #1622] — official docs page `coolify.io/docs/knowledge-base/cron-syntax` and `/scheduled-tasks` could not be directly fetched this session (harness blocked WebFetch); facts below cross-checked across multiple sources, flagged MEDIUM:

- Coolify has a built-in **Scheduled Tasks** feature on a resource (service/application). You configure: a **name**, a **command** to run, and a **frequency** (cron expression).
- The command runs **inside the resource's container** (Coolify execs into the running container). For a one-shot off the SAME image, the command is `bun packages/cron/dist/main.js`.
- **Cron syntax:** standard 5-field (`* * * * *`) PLUS predefined strings (`@daily`, `@hourly`, `@weekly`, etc.). E.g. `0 4 * * *` = 04:00 daily; `@daily` = once a day.
- **Timezone:** UTC by default inside the container (no built-in per-task TZ setting; a long-standing feature request). Document `CRON_SCHEDULE` as UTC and choose an off-peak hour. [MEDIUM]
- Operator-UI configured (Coolify dashboard → resource → Scheduled Tasks). Also reachable via Coolify API. The cron expression lives in **Coolify config**, NOT in `CRON_SCHEDULE` env — `CRON_SCHEDULE` is documented as the operator's source-of-truth value to enter into Coolify (D-2 keeps it as a documented tunable even though Coolify owns the actual clock).

**Recommended cron command (Coolify scheduled task):** `bun packages/cron/dist/main.js`
**Recommended default schedule:** `0 4 * * *` (04:00 UTC daily) — comfortably > 1h dedup window (D-3).

## Re-audit Cadence vs Dedup (Q3) — CRITICAL CONSTRAINT

[VERIFIED: audit-post.ts L29, L84-88]
- `DEDUP_TTL_MS = 60*60*1000` (1h), hardcoded.
- Dedup is **consumer-scoped**: `findRecentByUrlHash(urlHash, DEDUP_TTL_MS, consumerId)`. A recent `done|queued|running` job for the SAME consumer+url within 1h returns the cached `job_id` (no new insert). A prior `failed` job does NOT dedup — it re-enqueues.
- **Therefore:** a scheduled run with period **> 1h** always enqueues a FRESH audit (the prior cron job is older than the TTL). A daily/weekly cadence (the re-audit norm) is never suppressed. **A sub-1h schedule would silently dedup** to the existing job — re-audits would stop refreshing. Document loudly in `docs/deploy.md`: **"CRON_SCHEDULE must fire less often than once per hour; default daily."** No code change (D-3).

## Cron Auth + Config (Q4)

[VERIFIED: auth.ts]
- `GEO_API_KEYS` = comma-separated `token:consumer_id` pairs (first-colon split; backslash escaping for literal `,`/`:`). Add a `cron` entry: e.g. `GEO_API_KEYS=...existing...,<cron-token>:cron` and an `ottolax` entry `...,<ottolax-token>:ottolax`. **Operator action in Coolify env (DEFERRED-LIVE).**
- Cron side env (D-2): `CRON_API_TOKEN=<cron-token>` (the bearer), `GEO_API_BASE_URL` (e.g. the api service URL), `CRON_TARGET_URLS` (comma/newline list). `CRON_SCHEDULE` is documented for the operator to enter into Coolify's task config.
- `parseApiKeys` **fail-fasts** if `GEO_API_KEYS` is empty/unparseable — so the api won't start without it; the cron `assertEnv` fail-fasts on missing `CRON_*` (mirror).
- Update `.env.example` with `CRON_TARGET_URLS`, `CRON_API_TOKEN`, `GEO_API_BASE_URL`, `CRON_SCHEDULE` + the `:cron`/`:ottolax` `GEO_API_KEYS` examples.

## @geo/core Publishability (Q6)

[VERIFIED: core/package.json read 2026-06-04]
- `name: "@geo/core"`, `version: "0.1.0"`, **NO `"private": true"`**, `files: ["dist"]`, dual `exports` (import+require), `types` present. Zero runtime deps. **Technically publishable** as-is.
- BUT: scoped name `@geo/core` + no `publishConfig` + no registry/`repository` field. To actually publish to npm it needs `"publishConfig": { "access": "public" }` (or a private registry) and `repository`. The root is `private: true` with `workspaces`, so it's currently consumed via `workspace:*`.
- **Recommended cross-repo distribution for HOW** (simplest first): a **git dependency or local file/workspace dep** rather than npm publish. Options, simplest → most formal:
  1. If HOW joins this monorepo or a shared workspace: `"@geo/core": "workspace:*"`.
  2. Co-located checkout: `"@geo/core": "file:../geo-seo-claude/packages/core"` (after `bun run build` so `dist/` exists).
  3. Git dep: `"@geo/core": "github:owner/geo-seo-claude#path:packages/core"` (needs the subpath-publish setup / prepare script).
  4. Full npm publish: add `publishConfig.access=public`, bump rules, `npm publish` — heaviest, only if HOW is a truly separate npm consumer.
- **Recommend documenting option 2 (file dep) as the default** in `docs/consumers.md` — it works today with zero registry setup since HOW is a sibling repo (`C:\Users\artic\GitHub\hyperoptimizedwebsites`). The actual edit is the **cross-repo follow-up** (rule 20 — NOT done here).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cron scheduling/clock | A `setInterval` daemon in-container | Coolify Scheduled Task (D-1) | Crash-isolation, log capture, real cron expr, clean exit (rule 23) |
| HTTP client in cron | Custom http lib | Bun global `fetch` (D-8) | Built-in, zero dep |
| HTTP client in Python example | `requests` dependency | stdlib `urllib.request` | Portable, no install, runs anywhere CPython does |
| Re-audit dedup/ownership | New logic | Existing consumer-scoped dedup | Already in audit-post.ts; cron is just a consumer |
| Cron test infra | New harness | Phase-5 `pglite-helper` + `app.request` | Established, high fidelity (D-7) |
| HTTP contract spec in docs | Re-typed schema | `/openapi.json` reference | rule 21 source of truth |

## Common Pitfalls

### Pitfall 1: Sub-1h CRON_SCHEDULE silently dedups (re-audits stop refreshing)
**What goes wrong:** Operator sets `*/30 * * * *`; the 2nd run within the hour dedups to the 1st job — no fresh audit. **Avoid:** enforce cadence > 1h in docs; default `0 4 * * *`. **Warning sign:** re-audit `job_id`s repeat across runs.

### Pitfall 2: Cron task timezone confusion
**What goes wrong:** `CRON_SCHEDULE` assumed local time but Coolify runs UTC → fires at the wrong hour. **Avoid:** document schedules as UTC; pick an off-peak UTC hour. [MEDIUM — Coolify TZ behaviour]

### Pitfall 3: Partial failure aborts the batch
**What goes wrong:** One bad URL throws and the loop dies — remaining URLs never enqueued. **Avoid:** wrap each iteration in try/catch, accumulate results, continue; `process.exit(1)` only AFTER the loop if any failed (so Coolify marks the task failed but every good URL still fired). See Pattern 1.

### Pitfall 4: Cron double-firing / overlap
**What goes wrong:** A slow run still in flight when the next tick fires → two concurrent cron containers. **Avoid:** one-shot fires fast (just enqueues, doesn't wait for audits to complete — the worker does the slow work async), so overlap is unlikely; keep cadence daily. Note: Coolify scheduled tasks generally don't guard overlap — the short-lived enqueue-only design is the mitigation. Document.

### Pitfall 5: Token leakage in logs
**What goes wrong:** Logging the request/headers prints the bearer. **Avoid:** log only `url` + `job_id`/status; never the Authorization header (mirrors auth.ts "header never logged").

### Pitfall 6: `GEO_API_BASE_URL` trailing slash → `//audit`
**Avoid:** strip trailing slash in `assertEnv` (Pattern 2).

### Pitfall 7: Live-deferral boundary over-claimed
**What goes wrong:** Marking criterion 1/3 "done" without the deployed service. **Avoid:** be explicit — what's PROVEN NOW is: CONS-01 offline import test; cron loop unit test (in-process); CONS-02 client shape. What's DEFERRED-LIVE: actual Coolify scheduled firing, real jobs in prod history, real ottolax round-trip. (Mirrors Phase 6.)

## Runtime State Inventory

Not a rename/refactor phase — but new env + a Coolify resource are introduced:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None new — cron jobs land in existing `audit_jobs` (consumer_id="cron") | none (existing schema) |
| Live service config | NEW Coolify **Scheduled Task** resource (cmd `bun packages/cron/dist/main.js`, cron expr) — lives in Coolify UI, NOT git | operator registers (DEFERRED-LIVE) |
| OS-registered state | None (Coolify owns the cron clock, not host crontab) | none |
| Secrets/env vars | NEW: `CRON_TARGET_URLS`, `CRON_API_TOKEN`, `GEO_API_BASE_URL`, `CRON_SCHEDULE`; `GEO_API_KEYS` gains `:cron` + `:ottolax` entries | set in Coolify env (DEFERRED-LIVE); add to `.env.example` (this phase) |
| Build artifacts | NEW `packages/cron/dist/` (built by existing `bun run --filter '*' build`) | none beyond adding the package |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | cron entry + build | ✓ (image) | 1.3.1 | — |
| Python 3 | running ottolax example (optional, for CI smoke) | likely ✓ | — | contract-doc only (D-7) |
| Coolify Scheduled Tasks | live cron firing | DEFERRED | — | in-container loop (D-1 fallback) if unavailable |
| Deployed geo-api | live criterion 1 & 3 | ✗ (Phase 6 gate unmet) | — | DEFERRED-LIVE; unit tests cover code |

**Missing with no fallback (blocking live only):** deployed geo-api → criteria 1 & 3 live confirmation. Code is fully buildable + unit-testable now.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.8 |
| Config | per-package (workspace); `packages/cron` adds its own (copy api's) |
| Quick run | `bun run --filter @geo/cron test` (and `@geo/core` for CONS-01 example) |
| Full suite | `bun run --filter '*' test` |

### Phase Requirements → Test Map
| Req | Behavior | Test Type | Command | Exists? |
|-----|----------|-----------|---------|---------|
| DEPLOY-02 | cron POSTs /audit per URL w/ Bearer, jobs scoped to `cron` | unit (in-process app + PGlite) | `bun run --filter @geo/cron test` | ❌ Wave 0 |
| DEPLOY-02 | partial-failure: bad URL doesn't abort batch; exit code | unit | same | ❌ Wave 0 |
| DEPLOY-02 | `parseTargetUrls` comma/newline + invalid-URL fail-fast | unit | same | ❌ Wave 0 |
| CONS-01 | `@geo/core` imports + runs `checkRobots`/`detectRendering` offline | unit | `bun run --filter @geo/core test` (or example test) | ❌ Wave 0 |
| CONS-02 | Python client shape (POST→poll→parse) | manual / optional CI smoke vs in-process | `python examples/ottolax-client.py` (DEFERRED-LIVE) | ❌ Wave 0 |

### Sampling Rate
- Per task commit: `bun run --filter @geo/cron test`
- Per wave merge: `bun run --filter '*' test`
- Phase gate: full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/cron/package.json` + `tsup.config.ts` + `vitest` config
- [ ] `packages/cron/src/__tests__/cron.test.ts` — DEPLOY-02
- [ ] `examples/how-inline-usage.test.ts` — CONS-01
- [ ] Dockerfile: add `COPY packages/cron/package.json` line
- [ ] `.env.example`: add CRON_* + GEO_API_KEYS cron/ottolax examples

## Security Domain

### Applicable ASVS Categories
| Category | Applies | Standard Control |
|----------|---------|-----------------|
| V2 Authentication | yes | Bearer token via existing `GEO_API_KEYS`; cron gets own token (D-4) |
| V5 Input Validation | yes | `CRON_TARGET_URLS` validated with `new URL()` before POST (Pattern 2); API re-validates with zod |
| V6 Cryptography | reuse | Token compare is constant-time in existing auth.ts — cron doesn't re-implement |
| V7 Errors/Logging | yes | Never log Authorization header/token (Pitfall 5) |
| V10 SSRF | inherited | `CRON_TARGET_URLS` are audit *targets* (intended outbound); callback SSRF already guarded in audit-post.ts. Cron sends no callback_url |

### Threat Patterns
| Pattern | STRIDE | Mitigation |
|---------|--------|------------|
| Token in logs | Information Disclosure | Log url+job_id only |
| Compromised cron token enqueues arbitrary audits | Elevation | Dedicated low-privilege `cron` consumer; rotate via Coolify env |
| Malicious URL in CRON_TARGET_URLS | Tampering | URL-validate before POST; API normalizes + the worker's safe fetcher classifies IPs |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Coolify scheduled task runs cmd inside the resource container on a 5-field cron + `@daily` strings | Coolify Scheduled Tasks | LOW — if it spins a fresh one-shot container instead, the one-shot design still works; only the exec mechanism differs |
| A2 | Coolify cron runs UTC, no per-task TZ setting | Pitfall 2 | LOW — wrong-hour firing; mitigated by documenting UTC |
| A3 | `python3` available in target/CI for the example | Env Availability | LOW — D-7 allows contract-doc-only |
| A4 | `createApp({dal,fetcher,apiKeys,callbackResolver})` is the full deps shape | Pattern 5 | LOW — confirm exact `AppDeps` fields at implementation (app.ts L25+) |
| A5 | A `file:` dep is the simplest HOW distribution | @geo/core Publishability | LOW — executed cross-repo; documented as recommendation |

## Open Questions

1. **Exact `AppDeps` fields for `createApp` in the cron test.** Known: `dal`, `fetcher`, `apiKeys`; `audit-post.ts` references `deps.callbackResolver`. Planner/implementer must read full `packages/api/src/app.ts` L25-44 to wire the test target. Recommendation: copy an existing api test's `createApp(...)` call.
2. **Does Coolify exec into the long-running service container or spawn a one-shot?** Either is compatible with the one-shot script; document both. (Official docs page not fetchable this session.)
3. **CI smoke for the Python example (D-7 "optionally").** Could run `ottolax-client.py` against a `bun packages/api/dist/main.js` started in CI with a PGlite/throwaway DB. Recommend deferring to a follow-up unless trivial — contract-doc + example satisfy CONS-02 now.

## Sources

### Primary (HIGH)
- Codebase reads (2026-06-04): `packages/core/{package.json,src/index.ts,types.ts,robots.ts,rendering.ts,url.ts}`, `packages/api/src/{routes/audit-post.ts,routes/audit-get.ts,middleware/auth.ts,app.ts}`, `packages/worker/{package.json,src/main.ts,tsup.config.ts}`, `Dockerfile`, root `package.json`, `packages/api/src/__tests__/pglite-helper.ts`.
- `.planning/phases/07-cron-consumer-wiring/07-CONTEXT.md` (D-1..D-8).

### Secondary (MEDIUM)
- WebSearch + coollabsio/coolify GitHub discussions #3152, #2772, #1622, #3212 — Coolify scheduled tasks: command + cron frequency, docker exec into container, UTC default, cron-syntax page reference.

### Tertiary / unverifiable this session
- `coolify.io/docs/knowledge-base/cron-syntax` and `/scheduled-tasks` — WebFetch blocked by harness; facts cross-checked via WebSearch (flagged A1/A2).

## Metadata
**Confidence breakdown:**
- Standard stack / file layout: HIGH — mirrors verified worker package.
- HTTP contract + core signatures: HIGH — read from source.
- Coolify scheduled-task mechanics: MEDIUM — WebSearch-verified, official page not directly fetched.
- @geo/core publishability: HIGH — package.json read.

**Research date:** 2026-06-04
**Valid until:** ~2026-07-04 (stable; Coolify task UI may shift — re-verify the docs page when implementing the operator runbook).
