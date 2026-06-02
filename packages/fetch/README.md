# @geo/fetch

SSRF-hardened HTTP fetcher for the geo-seo-claude monorepo.

Implements the `@geo/core` `Fetcher` injection seam — zero network I/O inside
`@geo/core` itself; callers supply a conforming implementation.

---

## Public API

```ts
import { createSafeFetcher, FetchErrorCode } from "@geo/fetch";
import type { SafeFetcherOptions } from "@geo/fetch";
```

### `createSafeFetcher(options?): Fetcher`

Returns a `(url: string) => Promise<FetchResult>` that conforms exactly to
`@geo/core`'s `Fetcher` type.

```ts
const fetcher = createSafeFetcher({ maxBytes: 5_000_000 });
const result = await fetcher("https://example.com/robots.txt");
// result.error is undefined on success, or a FetchErrorCode string on failure
```

### `SafeFetcherOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `maxBytes` | `number` | `5_000_000` | Max response body size (raw wire AND decompressed). |
| `maxRedirects` | `number` | `5` | Max redirect hops before `TOO_MANY_REDIRECTS`. |
| `timeoutMs` | `number` | `10_000` | Header + body timeout in milliseconds. |
| `allowedPorts` | `number[]` | `[80, 443]` | URL ports accepted. |
| `resolver` | `Resolver` | node:dns | Injectable DNS resolver for testing. |
| `_testDispatcher` | `Dispatcher` | — | Injectable undici Dispatcher (tests only). |

### `FetchErrorCode`

Ten structured error codes (all returned as `FetchResult.error`, never thrown):

| Code | Trigger |
|---|---|
| `SSRF_BLOCKED_IP` | Resolved IP is in the deny-list (RFC 1918, loopback, link-local, etc.) |
| `SSRF_BLOCKED_SCHEME` | URL scheme not `http:` or `https:`, or userinfo present |
| `SSRF_BLOCKED_PORT` | Port not in `allowedPorts` |
| `DNS_RESOLUTION_FAILED` | DNS lookup failed or returned no addresses |
| `REDIRECT_BLOCKED` | A redirect target resolves to a blocked IP |
| `TOO_MANY_REDIRECTS` | Redirect chain exceeded `maxRedirects` |
| `RESPONSE_TOO_LARGE` | `Content-Length > maxBytes` (early reject) or streamed body exceeded `maxBytes` |
| `DECOMPRESSION_BOMB` | Decompressed bytes exceeded `maxBytes`, or > 2 stacked `Content-Encoding` layers |
| `CONNECT_TIMEOUT` | DNS/connect/header/body timeout |
| `FETCH_ERROR` | All other transport errors, unknown encoding |

---

## Injected-Fetcher Contract

`createSafeFetcher()` returns a value directly assignable to `@geo/core`'s
`Fetcher` type:

```ts
import type { Fetcher } from "@geo/core";
const f: Fetcher = createSafeFetcher();
```

`FetchResult` fields:
- `url` — original URL (not redirected-to URL).
- `status` — HTTP status code, `0` on error.
- `headers` — lowercase-keyed map (HTTP/2 convention).
- `body` — decoded UTF-8 string (empty on error).
- `redirectChain` — `{ url, status }[]` for each redirect hop followed.
- `error` — `FetchErrorCode` string or `undefined`.

---

## Security hardening (SEC-01 through SEC-05)

### SEC-01: IP deny-list

All A + AAAA records are resolved and checked before connecting. Blocked ranges:
RFC 1918, loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.x.x`, `fe80::/10`),
multicast, unique-local (`fc00::/7`), documentation, and unspecified.

### SEC-02: Resolve-then-pin

Connects to the validated IP (Host header set to original hostname for TLS SNI).
No second DNS lookup occurs at connect time.

> **Note on node:dns bypassing `/etc/hosts`:** The Node.js `dns.resolve4`/`dns.resolve6`
> APIs query the OS DNS resolver but do NOT consult `/etc/hosts`. If you need
> `/etc/hosts` entries to be honoured in tests, use a mock resolver via the
> `resolver` option.

### SEC-03: Per-hop redirect validation

Redirects are followed manually (`redirect: 'manual'`). Each `Location` target
is fully re-validated (IP deny-list + scheme + port) before connecting. Relative
`Location` headers are resolved against the current URL before validation.

### SEC-04: Streamed size cap + decompression-bomb defense

Two independent byte counters run on every response:

1. **Raw wire bytes** — `Content-Length > maxBytes` is rejected before the body
   is read (early reject → `RESPONSE_TOO_LARGE`). For chunked/streaming bodies
   the raw-byte counter is authoritative.
2. **Decompressed bytes** — after the final decompressor stage a `makeByteCounter`
   Transform caps decompressed output at `maxBytes` (→ `DECOMPRESSION_BOMB`).

`Content-Encoding` layers are capped at **2**. More than 2 encodings
returns `DECOMPRESSION_BOMB` immediately. Supported encodings: `gzip`, `x-gzip`,
`deflate`, `br`. Unknown encodings return `FETCH_ERROR`.

Decompression uses `node:zlib` only — no third-party dependencies.

### SEC-05: Structured error codes, never throws

Every failure path returns a `FetchResult` with `error` set to a `FetchErrorCode`
string. The fetcher itself never throws.

> **SEC-05 note on job-level `failed` mapping:** Mapping `FetchResult.error` codes
> to a job-level `failed` status (e.g. for a crawler queue) is the consumer's
> responsibility (Phase 4). This package only provides structured codes.

---

## Build

```sh
bun run build          # emits dist/index.js (ESM), dist/index.cjs (CJS), dist/index.d.ts
bunx tsc --noEmit -p tsconfig.check.json  # type-check including tests
```
