# Consumer Integration

geo-api serves two consumers via two distinct integration patterns. This doc
describes both. For the HTTP contract, **`/openapi.json` + `/docs` are the single
authoritative source of truth** (rule 21) — the shapes below are a convenience
summary, not a spec.

| Consumer | Pattern | Transport | Reference |
|----------|---------|-----------|-----------|
| `hyperoptimizedwebsites` (HOW) | Inline `@geo/core` import | none (in-process) | [CONS-01](#cons-01--how-inline-geocore) |
| `ottolax` | HTTP API | `POST /audit` → poll `GET /audit/{id}` | [CONS-02](#cons-02--ottolax-http) |

---

## CONS-01 — HOW inline `@geo/core`

HOW already has each page's HTML and robots.txt in hand from its own crawl, so it
does **not** call the geo-api HTTP service. It imports the deterministic checks from
`@geo/core` and runs them in-process with **zero network I/O**.

`@geo/core` is **zero runtime dependencies**, ships **dual ESM + CJS** (`./dist`),
is version **0.1.0**, and is **not** marked `private` (publishable). Its only I/O
seam is the injected `Fetcher` (D-05) — the caller supplies the bytes, the package
never reaches the network.

### Depending on `@geo/core`

Recommended default (HOW is a sibling repo): a **`file:` dependency** after building
the package.

```jsonc
// hyperoptimizedwebsites/package.json — DEFERRED cross-repo follow-up (see below)
{
  "dependencies": {
    "@geo/core": "file:../geo-seo-claude/packages/core"
  }
}
```

```bash
# build the package first so dist/ exists
cd geo-seo-claude/packages/core && bun run build
```

Alternatives (pick per deployment topology):

- **workspace** (`"@geo/core": "workspace:*"`) — only if HOW joins this monorepo.
- **git** (`"@geo/core": "github:owner/geo-seo-claude#path:packages/core"`) — pin to a ref.
- **npm publish** — `@geo/core` is publishable (zero-dep, dual ESM/CJS, not private);
  publish then `"@geo/core": "^0.1.0"`. Preferred once a registry is in place.

### Usage

See **`examples/how-inline-usage.ts`** (runnable: `bun examples/how-inline-usage.ts`)
and its offline proof test `examples/how-inline-usage.test.ts`.

```ts
import { checkRobots, detectRendering, type Fetcher } from "@geo/core";

// inject the bytes you already crawled — no network
const robots = await checkRobots("https://example.com", myFetcher);
const rendering = detectRendering(pageHtml); // 'ssr' | 'csr' | 'hybrid'
```

> **DEFERRED (cross-repo, rule 20):** the actual edit to HOW's `package.json` +
> import wiring lives in the `hyperoptimizedwebsites` repo and is a separate
> repo-scoped follow-up. It is **not** performed in geo-seo-claude commits.

---

## CONS-02 — ottolax HTTP

ottolax integrates over HTTP. It submits a URL, then polls until the audit is
terminal.

**Reference client: `examples/ottolax-client.py`** — stdlib-only Python 3 (no pip
deps). Run: `GEO_API_TOKEN=... python3 examples/ottolax-client.py https://example.com`.

### Auth

Every data route requires `Authorization: Bearer <token>`. The token is a
`GEO_API_KEYS` entry provisioned for the `ottolax` consumer (format
`token:consumer_id`, so e.g. `<token>:ottolax`). The client reads it from
`GEO_API_TOKEN` in the environment — **never hardcode the token**. Exempt (public)
paths: `/healthz`, `/openapi.json`, `/docs`.

### Flow (summary — see `/openapi.json` for the authoritative contract)

```
POST /audit            {"url": "https://..."}            -> 200 {"job_id": "..."}
GET  /audit/{job_id}                                     -> 200 {"status": ...}
```

- `POST /audit` → `200 {job_id}` (or deduped to an existing job for this consumer),
  `400 {error,message}` on invalid url / blocked `callback_url`, `401` on bad token.
- `GET /audit/{job_id}` → `200` with
  `{"status": queued|running|done|failed, score?, findings?, error_code?}`.
  `score` + `findings` appear **only** when `status == done`; `error_code` **only**
  when `status == failed`. `404` = not found **or** not owned by the caller.
- Poll on an interval with a bounded deadline until `status ∈ {done, failed}`.

Config: `GEO_API_BASE_URL` (base URL), `GEO_API_TOKEN` (bearer).

> **DEFERRED (cross-repo, rule 20):** wiring this client into the ottolax repo is a
> separate repo-scoped follow-up — not done here.
>
> **DEFERRED-LIVE:** the live end-to-end round-trip needs a deployed geo-api; the
> client is contract-correct but its live run is deferred until the service is up.

---

## Contract source of truth

The HTTP contract is defined by the running service:

- **`/openapi.json`** — machine-readable OpenAPI spec (generated from the routes).
- **`/docs`** — human-readable API reference.

Always treat these as authoritative over any prose summary in this document.
