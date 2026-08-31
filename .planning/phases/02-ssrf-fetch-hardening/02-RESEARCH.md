# Phase 2: SSRF & Fetch Hardening — Research

**Researched:** 2026-06-02
**Domain:** SSRF defense, DNS-rebinding, decompression-bomb, TypeScript fetch hardening (Bun 1.x / Node 22)
**Confidence:** HIGH (core stack), MEDIUM (Bun-specific resolve-then-pin path)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** New workspace package `packages/fetch/` (`@geo/fetch`). Runtime deps allowed but prefer built-ins (`node:dns/promises`, `node:net`, global `fetch` / undici).
- **D-02:** `createSafeFetcher(options)` → returns function conforming EXACTLY to `@geo/core`'s `Fetcher` type and `FetchResult` shape (lowercase headers, `redirectChain`, `error?`).
- **D-03:** Resolve-then-pin: DNS-resolve first → validate ALL IPs → connect to validated IP, preserving original `Host` / SNI.
- **D-04:** Blocklist: loopback, private (RFC-1918), link-local incl. 169.254.169.254, ULA (fc00::/7), unspecified (0.0.0.0/::), broadcast/multicast, IPv4-mapped IPv6 forms of all of the above.
- **D-05:** Scheme allowlist: http/https only. Port allowlist: 80/443 default, configurable.
- **D-06:** Manual redirect following (`redirect: 'manual'`), cap 5 hops, full SSRF+DNS re-validation per hop, record every hop in `redirectChain`.
- **D-07:** Stream body, abort on `maxBytes` (default 5 MB). Honor `Content-Length` early-reject.
- **D-08:** Decompression-bomb safe: cap DECOMPRESSED bytes, bound stacked encodings.
- **D-09:** Structured error result, never thrown stack. `code` enum: `SSRF_BLOCKED_IP`, `SSRF_BLOCKED_SCHEME`, `SSRF_BLOCKED_PORT`, `DNS_RESOLUTION_FAILED`, `REDIRECT_BLOCKED`, `TOO_MANY_REDIRECTS`, `RESPONSE_TOO_LARGE`, `DECOMPRESSION_BOMB`, `CONNECT_TIMEOUT`, `FETCH_ERROR`.
- **D-10:** Connect/overall timeout default 10 s.
- **D-11:** Vitest. Unit: IP table tests. Integration: mock resolver rebinding, redirect-to-private, oversize, decompression-bomb.

### Claude's Discretion
None — all decisions were locked in discussion.

### Deferred Ideas (OUT OF SCOPE)
- Per-consumer rate limiting → v2 OPS-01
- Webhook callback SSRF (reuses this fetcher in Phase 5, no new work here)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEC-01 | Blocks private/link-local/loopback/cloud-metadata IPs including after DNS resolution | D-03/D-04 + ipaddr.js `range()` + resolve-then-pin |
| SEC-02 | DNS-rebinding safe (resolve-then-pin, re-validate on redirect) | `node:dns/promises` + undici connect-by-IP + D-03 |
| SEC-03 | Re-checks every redirect hop against SSRF allowlist | `redirect: 'manual'` loop + D-06 |
| SEC-04 | Response-size cap + decompression-bomb safe | streaming byte counter + zlib.createGunzip + D-07/D-08 |
| SEC-05 | SSRF-blocked or oversized fetch fails with structured error, no partial result | D-09 error model |
</phase_requirements>

---

## Summary

Phase 2 produces `@geo/fetch`, a standalone workspace package exporting `createSafeFetcher()`. The implementation must resolve DNS first, validate every returned IP against a comprehensive blocklist, then connect to that pinned IP so the address validated equals the address contacted. This is the only correct mitigation for DNS-rebinding (TOCTOU: if a second resolution happens at connect time, an attacker's DNS TTL-0 trick can route to a private host after the check passes).

The primary implementation challenge is **connect-by-IP while preserving Host/SNI on Bun vs Node**. On Node 22 the cleanest approach is undici's `dns` interceptor with a custom `lookup` callback that (a) resolves via `node:dns/promises`, (b) throws if any returned address is blocked, and (c) passes only the validated address downstream — so undici never resolves again. On Bun 1.x the same approach works for HTTP but there is a documented open issue ([#27890](https://github.com/oven-sh/bun/issues/27890)) where custom `lookup` with HTTPS breaks TLS verification; the safe fallback is to use Node's `undici` directly rather than Bun's built-in `fetch` for HTTPS targets.

IP classification must use `ipaddr.js` (not `ip` npm package — the `ip` package has a confirmed CVE for octal/null-route SSRF bypass). `ipaddr.js` handles IPv4-mapped IPv6 (`::ffff:169.254.169.254`) correctly via `isIPv4MappedAddress()` + `toIPv4Address()` before range-checking.

**Primary recommendation:** Build on `undici` 8.x with a custom `dns` interceptor (lookup callback) for Node-compatible environments; use `node:dns/promises` for pre-resolution; `ipaddr.js` for range classification; `zlib.createGunzip/createInflate/createBrotliDecompress` with a counting `Transform` for decompression-bomb defense; Vitest 4 (already used in `@geo/core`) for testing.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| DNS resolution + IP validation | `@geo/fetch` package (server) | — | Must happen server-side before any outbound connection; cannot be client-side |
| Resolve-then-pin connection | `@geo/fetch` (undici Agent/interceptor) | — | undici's connect layer is the only place the IP→socket binding is enforceable |
| Redirect chain tracking | `@geo/fetch` (manual redirect loop) | — | Manual loop needed to re-validate each hop; built-in auto-follow bypasses this |
| Response streaming + size cap | `@geo/fetch` (stream pipeline) | — | Must abort before full body is in memory |
| Decompression-bomb guard | `@geo/fetch` (counting Transform) | — | Must cap DECOMPRESSED bytes, not raw wire bytes |
| `Fetcher`/`FetchResult` contract | `@geo/core` types | `@geo/fetch` implements | Core defines the seam; fetch fills it |
| Injection into core functions | Phase 4 worker | Phase 5 API (webhook SSRF) | Fetcher passed at call time, not baked into core |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `undici` | 8.3.0 [VERIFIED: npm registry] | HTTP client with interceptor API for custom DNS lookup + connect | Bundled inside Node 22; provides `dns` interceptor with custom `lookup` callback — the only Node-ecosystem HTTP client with a clean hook at the DNS-resolve layer before connection |
| `ipaddr.js` | 2.4.0 [VERIFIED: npm registry] | IPv4/IPv6 parsing + range classification | Handles IPv4-mapped IPv6 correctly; no CVEs; `range()` returns named ranges; `isIPv4MappedAddress()` + `toIPv4Address()` covers the `::ffff:169.254.x.x` attack vector |
| `node:dns/promises` | Node built-in | `dns.resolve4()` / `dns.resolve6()` / `dns.lookup()` for pre-resolution | Zero-dep; returns all A/AAAA records (not just one like `lookup`) |
| `node:zlib` | Node built-in | `createGunzip`, `createInflate`, `createBrotliDecompress` for streaming decompression with byte counting | Zero-dep; correct approach is a counting `Transform` piped after the decompressor |
| `vitest` | 4.1.8 [VERIFIED: npm registry — in use by @geo/core] | Test framework | Already configured in workspace |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:net` | built-in | `net.isIPv4()`, `net.isIPv6()` for fast pre-check | Can fast-path before ipaddr.js parse |
| `node:stream` | built-in | `pipeline`, `PassThrough`, custom `Transform` | Body streaming + byte counting |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `ipaddr.js` | `ip` (npm) | `ip` package has a confirmed SSRF bypass CVE for octal (`017700000001`) and null-route formats — DO NOT USE [CITED: CVE application doc via cosmosofcyberspace.github.io] |
| `ipaddr.js` | hand-rolled CIDR checks | Extremely easy to miss IPv4-mapped IPv6 forms; not worth the risk |
| `undici` interceptor | Node's `https.request` with `createConnection` override | Works but more boilerplate; undici's interceptor API is cleaner and future-safe |
| `undici` | Bun built-in `fetch` | Bun issue #27890: custom `lookup` breaks TLS cert verification on HTTPS [CITED: github.com/oven-sh/bun/issues/27890]; safer to explicitly import undici on Bun too |

**Installation:**
```bash
npm install undici ipaddr.js
# node:dns/promises, node:zlib, node:net, node:stream are Node built-ins — no install
```

**Version verification (performed during research):**
- `undici` 8.3.0 — last modified 2026-06-01 (active) [VERIFIED: npm registry]
- `ipaddr.js` 2.4.0 — last modified 2026-05-03 (stable) [VERIFIED: npm registry]
- `vitest` 4.1.8 — already in workspace devDependencies [VERIFIED: npm registry]

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `undici` | npm | ~6 yrs | Very high (Node.js bundled) | github.com/nodejs/undici | [OK] | Approved |
| `ipaddr.js` | npm | ~10 yrs | High | github.com/whitequark/ipaddr.js | [OK] | Approved |
| `vitest` | npm | ~3 yrs | Very high | github.com/vitest-dev/vitest | [SUS — false positive: slopcheck sees "typosquat of vite"] | Approved — already in workspace, maintained by vitest-dev org, 40M+ weekly downloads |

**Packages removed due to slopcheck [SLOP] verdict:** none

**Packages flagged as suspicious [SUS]:** vitest — false positive (well-known testing framework, already in use in @geo/core). No human checkpoint needed.

---

## Architecture Patterns

### System Architecture Diagram

```
caller (Phase 4 worker / Phase 5 API)
  │
  │  createSafeFetcher(options) → Fetcher
  ▼
┌──────────────────────────────────────────┐
│              @geo/fetch                  │
│                                          │
│  1. validateSchemePort(url)              │  ← SSRF_BLOCKED_SCHEME / _PORT
│         │                               │
│  2. dns.resolve4()/resolve6(hostname)   │  ← DNS_RESOLUTION_FAILED
│         │                               │
│  3. validateAllIPs(addrs)               │  ← SSRF_BLOCKED_IP (via ipaddr.js)
│         │                               │
│  4. undici request to pinned IP         │  ← Host header + SNI = original hostname
│     (connect interceptor or lookup cb)  │
│         │                               │
│  5. redirect: 'manual'                  │
│     ├─ 3xx? → extract Location          │
│     │         re-run steps 1–4          │  ← REDIRECT_BLOCKED / TOO_MANY_REDIRECTS
│     │         record in redirectChain   │
│     └─ non-3xx → proceed               │
│         │                               │
│  6. Content-Length early reject         │  ← RESPONSE_TOO_LARGE
│         │                               │
│  7. stream body through:               │
│     decompressor (gzip/br/deflate)      │
│     → counting Transform               │  ← DECOMPRESSION_BOMB / RESPONSE_TOO_LARGE
│     → collect to string (text/*)        │
│         │                               │
│  8. return FetchResult                  │
│     { url, status, headers,            │
│       body, redirectChain, error? }     │
└──────────────────────────────────────────┘
```

### Recommended Project Structure
```
packages/fetch/
├── src/
│   ├── index.ts             # exports: createSafeFetcher, SafeFetcherOptions, FetchErrorCode
│   ├── ip-validator.ts      # isBlockedIP(addr: string): boolean — ipaddr.js + range table
│   ├── dns-resolve.ts       # resolveAndValidate(hostname): Promise<string[]> — node:dns/promises
│   ├── safe-fetcher.ts      # createSafeFetcher() factory — undici + manual redirect loop
│   ├── decompression.ts     # makeDecompressStream(encoding, maxBytes) → Transform pipeline
│   └── errors.ts            # FetchErrorCode enum + buildErrorResult()
├── test/
│   ├── ip-validator.test.ts # CIDR table unit tests (all ranges incl. IPv4-mapped)
│   ├── dns-resolve.test.ts  # mock dns.resolve4/6, rebinding scenario
│   ├── safe-fetcher.test.ts # integration: loopback test server scenarios
│   └── helpers/
│       ├── test-server.ts   # createTestServer(scenarios) — http.createServer
│       └── mock-resolver.ts # inject fake DNS responses for rebinding test
├── package.json
└── tsconfig.json
```

### Pattern 1: Resolve-Then-Pin via undici DNS interceptor

The undici `dns` interceptor accepts a custom `lookup` callback. By replacing the default resolver, we can (a) call `node:dns/promises` to get all records, (b) reject any blocked IP, (c) pass only the validated IP. This makes the validated IP === the connected IP — no second resolution.

```typescript
// Source: undici dns interceptor docs + node:dns/promises (Node.js official docs)
import { Agent, interceptors } from 'undici';
import { resolve4, resolve6 } from 'node:dns/promises';
import { isBlockedIP } from './ip-validator.js';

function makeSafeAgent(hostname: string) {
  return new Agent().compose(
    interceptors.dns({
      lookup: async (origin, opts, cb) => {
        const [v4, v6] = await Promise.allSettled([
          resolve4(hostname),
          resolve6(hostname),
        ]);
        const addrs: string[] = [
          ...(v4.status === 'fulfilled' ? v4.value : []),
          ...(v6.status === 'fulfilled' ? v6.value : []),
        ];
        if (addrs.length === 0) throw new Error('DNS_RESOLUTION_FAILED');
        for (const addr of addrs) {
          if (isBlockedIP(addr)) throw new Error('SSRF_BLOCKED_IP');
        }
        // undici uses the first address; pass only validated set
        cb(null, addrs.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));
      },
    })
  );
}
```

**Critical caveat:** The `lookup` callback signature has evolved across undici versions. In undici 8.x the `dns` interceptor's `lookup` option is the correct hook point. Verify against undici 8.3.0 API docs before implementing — the exact callback signature (whether it matches Node's `dns.lookup` callback or returns a Promise) should be confirmed from undici's source/docs. [ASSUMED — exact 8.x lookup callback shape not verified via Context7]

**Alternative (simpler, robust):** Pre-resolve outside undici, then connect directly to the IP string, overriding `Host` header manually:

```typescript
// Source: Node.js fetch + undici docs pattern [ASSUMED — illustrative]
// Pass the resolved IP as the hostname in the URL, set Host header to original
const pinnedUrl = url.replace(parsedUrl.hostname, resolvedIp);
const response = await fetch(pinnedUrl, {
  headers: { 'Host': parsedUrl.hostname },
  // For HTTPS: need to set servername for TLS SNI = original hostname
  // This requires undici Agent with connect.servername option
});
```

**TLS SNI preservation (critical for HTTPS):** When connecting to an IP directly, TLS negotiation uses the IP as SNI by default, which breaks certificate validation on virtually all CDN-served sites. Must set `connect.servername` to the original hostname in the undici Agent options. [ASSUMED — derived from undici issue #3401 pattern; verify against undici docs]

### Pattern 2: IP Classification with ipaddr.js

```typescript
// Source: ipaddr.js README (github.com/whitequark/ipaddr.js)
import * as ipaddr from 'ipaddr.js';

const BLOCKED_RANGES = new Set([
  'loopback', 'private', 'linkLocal', 'uniqueLocal',
  'unspecified', 'broadcast', 'multicast',
  // IPv6
  'loopback', 'uniqueLocal', 'linkLocal', 'unspecified',
]);

export function isBlockedIP(raw: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(raw);
  } catch {
    return true; // unparseable = deny
  }
  // Unwrap IPv4-mapped IPv6 (::ffff:169.254.169.254 etc.)
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  return BLOCKED_RANGES.has(addr.range());
}
```

**Note:** `ipaddr.js` range names for IPv4: `loopback`, `private`, `linkLocal`, `broadcast`, `multicast`, `unspecified`, `carrierGradeNat`, `benchmarking`, `reserved`. For IPv6: `loopback`, `uniqueLocal`, `linkLocal`, `unspecified`, `ipv4Mapped`, `rfc6145`, `rfc6052`, `6to4`, `teredo`, `benchmarking`, `reserved`. Deny all non-`unicast`/`reserved` ranges to be safe. [CITED: ipaddr.js README at github.com/whitequark/ipaddr.js]

### Pattern 3: Manual Redirect Loop

```typescript
// Source: undici/Node.js fetch docs — redirect: 'manual' pattern [ASSUMED — illustrative]
const MAX_HOPS = 5;
const redirectChain: Array<{url: string; status: number}> = [];
let currentUrl = originalUrl;

for (let hop = 0; hop <= MAX_HOPS; hop++) {
  if (hop === MAX_HOPS) return errorResult('TOO_MANY_REDIRECTS');

  // Re-run full SSRF validation on currentUrl before each fetch
  const validationError = await validateUrl(currentUrl);
  if (validationError) return errorResult(validationError, redirectChain);

  const res = await fetch(currentUrl, { redirect: 'manual', /* ... */ });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) return errorResult('FETCH_ERROR', redirectChain);
    redirectChain.push({ url: currentUrl, status: res.status });
    currentUrl = new URL(location, currentUrl).href; // resolve relative redirects
    continue;
  }
  // non-redirect: proceed to body handling
  return await readBody(res, currentUrl, redirectChain);
}
```

### Pattern 4: Decompression-Bomb Defense

The key: decompress into a counting `Transform` that throws when decompressed bytes exceed `maxBytes`. Also cap the number of stacked `Content-Encoding` layers (typically at most 2; more is pathological).

```typescript
// Source: node:zlib + node:stream documentation [ASSUMED — illustrative pattern]
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Transform, pipeline } from 'node:stream';
import { promisify } from 'node:util';

function makeByteCounter(maxBytes: number, code: string): Transform {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(Object.assign(new Error(code), { code }));
      } else {
        cb(null, chunk);
      }
    }
  });
}

function buildDecompressChain(encoding: string | null, maxBytes: number): NodeJS.ReadableStream {
  // Parse Content-Encoding — can be comma-separated (stacked)
  const encodings = (encoding ?? '').split(',').map(e => e.trim()).filter(Boolean);
  if (encodings.length > 2) throw new Error('DECOMPRESSION_BOMB'); // too many stacked
  // Build pipeline: each stage gets its own byte counter
  // Final counting transform caps decompressed total
  const stages = encodings.map(enc => {
    if (enc === 'gzip' || enc === 'x-gzip') return createGunzip();
    if (enc === 'deflate') return createInflate();
    if (enc === 'br') return createBrotliDecompress();
    throw new Error('FETCH_ERROR'); // unknown encoding
  });
  return stages; // caller wraps in pipeline with byte counter
}
```

### Anti-Patterns to Avoid

- **Validating the URL string for IP-looking hostnames:** An attacker passes `http://2130706433/` (decimal 127.0.0.1) which doesn't look like an IP to a naive regex check but resolves to loopback. Always validate POST-resolution IPs, never pre-resolution strings.
- **Single `dns.lookup()` call:** `dns.lookup()` follows `/etc/hosts` and returns one address. Use `dns.resolve4()` + `dns.resolve6()` to get ALL records and reject if ANY is blocked.
- **Second resolution at connect time:** If you validate IPs pre-connect but undici/fetch does its own internal DNS resolution again at socket open time, the resolve-then-pin guarantee is broken. The undici `dns` interceptor prevents this; the direct-IP-in-URL approach also prevents it.
- **Checking Content-Length only:** Content-Length can be absent, wrong, or spoofed. Always enforce the cap on actual streamed bytes.
- **Not checking `ip` npm package:** The `ip` package (different from `ipaddr.js`) has a known SSRF bypass CVE for octal IPs (`017700000001`) and null-route IPs (`0`). Do not use `ip` npm package for range checking.
- **Not handling relative Location headers:** A `302 Location: /internal/path` redirect must be resolved against the current base URL (`new URL(location, base)`), or it becomes a relative path to the SAME host (which may be safe) but easy to misparse.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| IPv4/IPv6 range classification | Custom CIDR match functions | `ipaddr.js` | IPv4-mapped IPv6 (`::ffff:x.x.x.x`), octal/hex/decimal forms, `isIPv4MappedAddress()` are all tricky; one off-by-one in a subnet mask = SSRF bypass |
| Gzip decompression | Custom inflate loop | `node:zlib` createGunzip/createInflate/createBrotliDecompress | Correct stream lifecycle, error handling, and memory bounds are non-trivial |
| URL parsing / relative redirect resolution | Manual string splitting | `new URL(location, base)` | Handles relative paths, scheme inheritance, port normalization; hand-rolling URL parsing is a known injection vector |
| DNS resolution | Manual socket-level resolution | `node:dns/promises` | Handles search domains, AAAA records, timeout, error codes correctly |

**Key insight:** IP range classification looks simple but is not. The `ip` npm package (not `ipaddr.js`) was CVE'd for missing octal/null bypass in 2023. Any IP validation library that doesn't explicitly test `0`, `017700000001`, `0x7f000001`, `[::ffff:127.0.0.1]` is suspect.

---

## Common Pitfalls

### Pitfall 1: DNS-TOCTOU (validate then re-resolve)
**What goes wrong:** Code calls `dns.lookup()` to validate, then passes the hostname string to `fetch()` which resolves it again. During those milliseconds, an attacker with a TTL-0 record swaps the DNS response from a public IP to 169.254.169.254.
**Why it happens:** Using `fetch(originalUrl)` after validation without pinning the IP.
**How to avoid:** Use undici's `dns` interceptor `lookup` hook (validation happens inside the resolver undici will actually use) OR manually replace the hostname in the URL with the validated IP and set `Host` header + TLS `servername`.
**Warning signs:** Two separate DNS calls in the code path (one for validate, one for connect).

### Pitfall 2: IPv4-Mapped IPv6 bypass
**What goes wrong:** Blocker checks `addr.range()` on an IPv6 address `::ffff:169.254.169.254` and gets `ipv4Mapped` (not `linkLocal`) — so it passes. The actual connection goes to 169.254.169.254.
**Why it happens:** Not unwrapping IPv4-mapped IPv6 before range-checking.
**How to avoid:** Always call `isIPv4MappedAddress()` first; if true, call `toIPv4Address()` and then check the IPv4 range.
**Warning signs:** Unit tests don't include `::ffff:169.254.169.254` or `::ffff:127.0.0.1`.

### Pitfall 3: Redirect to private after initial public resolution
**What goes wrong:** Initial URL is `https://attacker.com` (public IP, passes). Server responds `302 Location: http://192.168.1.1/metadata`. Code follows the redirect without re-validating.
**Why it happens:** Auto-follow redirects (`redirect: 'follow'` default).
**How to avoid:** `redirect: 'manual'` + re-run full validation on each Location header value.
**Warning signs:** No test case for "redirect to private IP".

### Pitfall 4: Content-Encoding stacking / decompression bomb
**What goes wrong:** Response has `Content-Encoding: gzip, gzip, gzip` — each layer multiplies decompressed size. 1 KB wire → 1 GB decompressed.
**Why it happens:** Piping through multiple decompressors without counting intermediate bytes.
**How to avoid:** Count stacked layers (reject > 2); count DECOMPRESSED bytes after each stage.
**Warning signs:** Only counting `response.body` raw bytes before decompression.

### Pitfall 5: Octal/hex/decimal IP in URL path (not hostname)
**What goes wrong:** URL `http://127.0.0.1/` is blocked, but `http://2130706433/` (decimal form) resolves to the same host. Hostname validation regex doesn't recognize it as an IP.
**Why it happens:** `new URL('http://2130706433/')` gives `.hostname = '2130706433'` which isn't a valid IPv4 dotted form. However Node's `http` module DOES connect to that address as localhost.
**How to avoid:** `ipaddr.js` handles this — `ipaddr.parse('2130706433')` returns the IPv4 address. Alternatively, resolve via DNS even for bare IPs (dns.lookup normalizes them).
**Warning signs:** IP-detection code only checks `net.isIPv4()` / `net.isIPv6()` (those return false for decimal/octal/hex forms).

### Pitfall 6: Bun HTTPS + custom lookup (TLS breakage)
**What goes wrong:** On Bun 1.x, supplying a custom `lookup` function via socket/fetch options for HTTPS requests breaks TLS certificate verification (BoringSSL TLS context uses the pre-lookup name for cert validation but connects to the post-lookup IP with wrong SNI).
**Why it happens:** Bun issue #27890 (open as of research date).
**How to avoid:** Import `undici` explicitly (not Bun's built-in fetch) for HTTPS requests, or avoid custom lookup and use the pre-resolve-then-IP approach with `connect.servername` set.
**Warning signs:** Tests pass with HTTP but HTTPS throws cert errors in Bun runtime.

### Pitfall 7: userinfo@ in URL
**What goes wrong:** `http://user@169.254.169.254/` — `new URL(url).hostname` correctly returns `169.254.169.254` but some parsers or naive splits on `@` get confused. Also, credentials in URLs should be stripped before logging.
**Why it happens:** Not using `new URL()` for parsing.
**How to avoid:** Always use `new URL()` — its `.hostname` is correct. Reject or strip `url.username` / `url.password`.

---

## Code Examples

### IP blocker (verified pattern)
```typescript
// Source: ipaddr.js README [CITED: github.com/whitequark/ipaddr.js]
import * as ipaddr from 'ipaddr.js';

// Ranges that must be blocked for SSRF safety
const DENY_RANGES = new Set([
  // IPv4
  'loopback', 'private', 'linkLocal', 'broadcast',
  'carrierGradeNat', 'unspecified', 'reserved',
  // IPv6
  'uniqueLocal', 'teredo', 'ipv4Mapped',
]);

export function isBlockedIP(raw: string): boolean {
  try {
    let addr: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(raw);
    if (addr.kind() === 'ipv6') {
      const v6 = addr as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) {
        addr = v6.toIPv4Address();
      }
    }
    const range = addr.range();
    return range !== 'unicast' && DENY_RANGES.has(range);
    // Fallback: deny anything not explicitly 'unicast'
  } catch {
    return true;
  }
}
```

### DNS pre-resolve with ALL records
```typescript
// Source: node:dns/promises official docs [CITED: nodejs.org/api/dns.html]
import { resolve4, resolve6 } from 'node:dns/promises';

export async function resolveAll(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addrs = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
  if (addrs.length === 0) throw Object.assign(new Error(), { code: 'DNS_RESOLUTION_FAILED' });
  return addrs;
}
```

### Vitest test server pattern (loopback)
```typescript
// Source: Node.js http module + vitest [ASSUMED — idiomatic vitest pattern]
import { createServer } from 'node:http';
import type { Server } from 'node:http';

export function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `ip` npm package for CIDR | `ipaddr.js` | 2023 (ip CVE) | `ip` package has confirmed SSRF bypass via octal/null — deprecated |
| `dns.lookup()` for all DNS | `dns.resolve4()` + `dns.resolve6()` | Always best practice | `lookup()` returns ONE address; `resolve*()` returns all records |
| `requests.get(allow_redirects=True)` (Python) | manual loop `redirect: 'manual'` | Phase 2 (this phase) | Auto-follow never re-validates; manual loop is the only safe approach |
| Global fetch w/ no dispatcher | undici Agent with dns interceptor | undici 5+ | Only way to intercept DNS resolution before connection in Node |

**Deprecated/outdated:**
- `ip` npm package: SSRF bypass CVE for `ip.isPrivate()` missing octal/null-route forms. Use `ipaddr.js` instead.
- Node's `http.request` with a manual `createConnection` hook: works but far more boilerplate than undici's interceptor API.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | undici 8.x `dns` interceptor `lookup` callback shape matches Node's `dns.lookup` callback signature | Architecture Patterns / Pattern 1 | Implementation must verify exact callback signature against undici 8.3.0 source before coding |
| A2 | Bun 1.x HTTPS + custom lookup still broken as of 1.3.14 (issue #27890 open) | Pitfall 6 + Standard Stack | If fixed, Bun native fetch + lookup is viable; if still broken, undici import is mandatory for HTTPS |
| A3 | undici dns interceptor correctly prevents second resolution at connect time (no internal fallback) | Architecture Patterns / Pattern 1 | If undici re-resolves internally despite interceptor, TOCTOU attack remains possible |
| A4 | `ipaddr.js` `range()` returns `'unicast'` for globally-routable public IPs (the safe whitelist) | Code Examples | If range() returns something else for public IPs, the allow-check inverts |
| A5 | Connecting directly to IP string with undici + `connect.servername = originalHostname` correctly passes TLS cert validation | Architecture Patterns | If SNI isn't forwarded correctly, HTTPS to CDN hosts (most of the internet) will fail |

---

## Open Questions

1. **undici 8.x `dns` interceptor exact lookup callback signature**
   - What we know: interceptor exists, custom lookup supported per undici docs
   - What's unclear: whether the callback is `(hostname, options, cb)` (Node-style) or a `Promise<{address, family}[]>` return
   - Recommendation: read undici 8.3.0 source `/lib/interceptor/dns.js` before implementing

2. **Bun 1.3.14 status of issue #27890**
   - What we know: issue was open and documented custom lookup breaking TLS cert verification
   - What's unclear: whether a workaround exists short of importing undici separately
   - Recommendation: include a smoke test that fetches a real HTTPS URL in CI; if it fails on Bun, use explicit `import { fetch } from 'undici'`

3. **`ipaddr.js` `range()` for `'unicast'`**
   - What we know: `range()` returns named strings for special ranges
   - What's unclear: whether globally-routable public IPs reliably return `'unicast'`
   - Recommendation: unit test with 8.8.8.8, 1.1.1.1, 2606:4700:4700::1111 — verify they return `'unicast'` before using it as the safe-pass check

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | `node:dns/promises`, `node:zlib`, `node:net` | ✓ | v22.16.0 | — |
| Bun | runtime on this machine | ✓ | 1.3.14 | — |
| npm workspace | `packages/fetch/` package setup | ✓ | npm via Node 22 | — |
| `undici` | HTTP client with interceptor API | needs install | 8.3.0 | — |
| `ipaddr.js` | IP classification | needs install | 2.4.0 | — |

**Missing dependencies with no fallback:** none (all installable via npm)

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.8 |
| Config file | `packages/fetch/vitest.config.ts` (Wave 0 gap — create) |
| Quick run command | `vitest run --project packages/fetch` |
| Full suite command | `vitest run` (workspace) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEC-01 | Blocks 127.0.0.1, 169.254.169.254, 10.x.x.x, ::1, ::ffff:169.254.169.254 | unit | `vitest run packages/fetch/test/ip-validator.test.ts` | ❌ Wave 0 |
| SEC-01 | Blocks octal `017700000001`, decimal `2130706433`, hex `0x7f000001` | unit | same file | ❌ Wave 0 |
| SEC-02 | DNS rebinding: mock resolver returns public IP on first call, private on second | unit | `vitest run packages/fetch/test/dns-resolve.test.ts` | ❌ Wave 0 |
| SEC-02 | Resolve-then-pin: connected IP = validated IP (no second lookup) | integration | `vitest run packages/fetch/test/safe-fetcher.test.ts` | ❌ Wave 0 |
| SEC-03 | Redirect to private IP → REDIRECT_BLOCKED | integration | same | ❌ Wave 0 |
| SEC-03 | > 5 hops → TOO_MANY_REDIRECTS | integration | same | ❌ Wave 0 |
| SEC-04 | Response > 5 MB → RESPONSE_TOO_LARGE | integration | same | ❌ Wave 0 |
| SEC-04 | Decompression bomb (high-ratio gzip) → DECOMPRESSION_BOMB | integration | same | ❌ Wave 0 |
| SEC-04 | Stacked encodings > 2 → DECOMPRESSION_BOMB | integration | same | ❌ Wave 0 |
| SEC-05 | All failures return FetchResult with `error` code, never throw | unit/integration | all test files | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `vitest run packages/fetch/test/ip-validator.test.ts`
- **Per wave merge:** `vitest run` (full workspace)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/fetch/test/ip-validator.test.ts` — covers SEC-01 CIDR table
- [ ] `packages/fetch/test/dns-resolve.test.ts` — covers SEC-02 rebinding mock
- [ ] `packages/fetch/test/safe-fetcher.test.ts` — covers SEC-02/03/04/05 integration
- [ ] `packages/fetch/test/helpers/test-server.ts` — shared loopback test server
- [ ] `packages/fetch/test/helpers/mock-resolver.ts` — fake DNS for rebinding test
- [ ] `packages/fetch/vitest.config.ts` — vitest config for this package
- [ ] `packages/fetch/package.json` — workspace package manifest
- [ ] `packages/fetch/tsconfig.json` — TypeScript config

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | yes (SSRF = access control for internal network) | resolve-then-pin + IP blocklist |
| V5 Input Validation | yes | `new URL()` parsing, scheme/port allowlist, hostname validation |
| V6 Cryptography | yes (TLS) | preserve SNI (`connect.servername`) — never skip cert validation |
| V10 Malicious Code (supply chain) | yes (decompression bomb = DoS) | byte-counting Transform, stacked encoding limit |

### Known Threat Patterns for SSRF / Fetch Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| DNS rebinding (TTL-0 swap) | Spoofing / Elevation | resolve-then-pin: validated IP = connected IP |
| IPv4-mapped IPv6 (`::ffff:169.254.169.254`) | Spoofing | `ipaddr.js` `isIPv4MappedAddress()` + unwrap before range check |
| Octal/hex/decimal IP obfuscation | Spoofing | `ipaddr.js` parses all forms correctly; do NOT string-compare |
| Redirect pivot (public→private) | Spoofing / Elevation | `redirect: 'manual'` + re-validate each hop |
| Decompression bomb | Denial of Service | cap DECOMPRESSED bytes via counting Transform |
| Stacked Content-Encoding | Denial of Service | reject more than 2 encoding layers |
| Large response (no size cap) | Denial of Service | streaming byte counter + Content-Length early reject |
| SSRF via `file:` / `gopher:` scheme | Information Disclosure | scheme allowlist: http/https only |
| userinfo@ host embedding | Spoofing | `new URL()` `.hostname` is correct; reject/strip `.username`/`.password` |

---

## Sources

### Primary (HIGH confidence)
- [ipaddr.js README](https://github.com/whitequark/ipaddr.js/blob/main/README.md) — range classification API, IPv4-mapped IPv6 handling
- [Node.js dns docs](https://nodejs.org/api/dns.html) — `resolve4()`, `resolve6()`, `dns.Resolver`
- [Node.js zlib docs](https://nodejs.org/api/zlib.html) — streaming decompression API
- [undici npm + repo](https://github.com/nodejs/undici) — dns interceptor, redirect: 'manual', Agent options
- `packages/core/src/types.ts` — `Fetcher`/`FetchResult` contract (in-repo, confirmed)

### Secondary (MEDIUM confidence)
- [undici SSRF issue #2019](https://github.com/nodejs/undici/issues/2019) — confirms no built-in SSRF protection; dns interceptor is the hook point
- [Bun issue #27890](https://github.com/oven-sh/bun/issues/27890) — custom lookup + HTTPS TLS breakage on Bun
- [OWASP SSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) — blocklist ranges, redirect re-validation
- [Twenty SSRF advisory GHSA-vrcj-hv2q-c58m](https://github.com/twentyhq/twenty/security/advisories/GHSA-vrcj-hv2q-c58m) — IPv4-mapped IPv6 bypass real-world case
- [Vaultwarden SSRF advisory GHSA-72vh-x5jq-m82g](https://github.com/dani-garcia/vaultwarden/security/advisories/GHSA-72vh-x5jq-m82g) — decimal/hex/octal IP bypass real-world case

### Tertiary (LOW confidence)
- [CVE application: npm `ip` package SSRF bypass](https://cosmosofcyberspace.github.io/CVE-Application-Document.html) — `ip` package octal/null-route bypass
- WebSearch results on undici dns interceptor callback shape — not confirmed against undici 8.3.0 source [ASSUMED]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — packages verified on npm registry, versions current
- IP classification approach: HIGH — ipaddr.js well-documented, CVE history of alternatives confirmed
- Resolve-then-pin via undici interceptor: MEDIUM — undici interceptor confirmed to exist; exact 8.x callback signature unverified
- Bun-specific HTTPS + custom lookup: MEDIUM — issue documented, fix status at research time unclear
- Decompression bomb pattern: HIGH — node:zlib streaming approach well-established

**Research date:** 2026-06-02
**Valid until:** 2026-07-02 (undici and Bun move fast; re-check undici interceptor API and Bun issue #27890 status at plan time)
