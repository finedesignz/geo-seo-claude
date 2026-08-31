---
phase: 02-ssrf-fetch-hardening
plan: "01"
subsystem: "@geo/fetch"
tags: [ssrf, dns, security, fetch, undici]
dependency_graph:
  requires: ["02-00"]
  provides: ["createSafeFetcher", "resolveAndValidate"]
  affects: ["@geo/fetch public API", "SEC-01", "SEC-02", "SEC-05"]
tech_stack:
  added: ["undici Agent (IP-pinned connect)", "node:dns/promises resolve4+resolve6"]
  patterns: ["resolve-then-pin", "injectable resolver", "MockAgent test seam"]
key_files:
  created:
    - packages/fetch/src/dns-resolve.ts
    - packages/fetch/src/__tests__/dns-resolve.test.ts
    - packages/fetch/src/__tests__/safe-fetcher.test.ts
    - packages/fetch/src/safe-fetcher.ts
  modified:
    - packages/fetch/src/index.ts
    - packages/fetch/src/__tests__/skeleton.test.ts
decisions:
  - "resolve-then-pin via undici Agent(connect.servername=originalHostname) + pinnedUrl with IP substituted — no undici dns-interceptor used (simpler, no caching layer)"
  - "_testDispatcher: Dispatcher seam allows MockAgent happy-path tests post-validation; production path omits it"
  - "Direct IP literals (decimal/octal/hex/IPv6-mapped) detected and blocked via isDirectIpLiteral + isBlockedIP without DNS round-trip"
  - "noUncheckedIndexedAccess guard on validatedIps[0] with explicit undefined check"
  - "rootDir TS6059 errors are pre-existing (Wave 0 design) — test helpers outside src/ are intentional; source files typecheck clean"
metrics:
  duration: "~20 min"
  completed: "2026-06-02"
  tasks_completed: 2
  files_changed: 6
  tests_added: 65
  tests_total: 73
---

# Phase 2 Plan 01: createSafeFetcher Summary

**One-liner:** SSRF-hardened `createSafeFetcher` with resolve-then-pin DNS (undici Agent + pinned IP URL), scheme/port/userinfo allowlists, direct IP literal blocking, and injectable resolver/dispatcher seams for deterministic tests.

---

## What Was Built

**Task 1 — `dns-resolve.ts`**

`resolveAndValidate(hostname, resolver?)` aggregates ALL A + AAAA records via `node:dns/promises` `resolve4 + resolve6` (NOT `dns.lookup`). Any blocked IP in the result set poisons the whole hostname (SSRF_BLOCKED_IP). Empty result → DNS_RESOLUTION_FAILED. Resolver is injectable for tests. `DnsValidationError` carries a `.code` the caller maps to `buildErrorResult`.

**Task 2 — `safe-fetcher.ts`**

`createSafeFetcher(options)` returns a `Fetcher` conforming exactly to `@geo/core Fetcher → FetchResult`. Pipeline:

1. `new URL()` parse — throws on malformed → SSRF_BLOCKED_SCHEME
2. Userinfo deny — `url.username/password` present → SSRF_BLOCKED_SCHEME (T-02-08)
3. Scheme allowlist — only `http:` / `https:` (T-02-06)
4. Port allowlist — default [80, 443] (T-02-07)
5. Direct IP literal detection — decimal/octal/hex/IPv6-mapped bypass DNS, go straight to `isBlockedIP` → SSRF_BLOCKED_IP (REVIEWS HIGH #3)
6. `resolveAndValidate` — single call, validated IP set returned (SEC-01)
7. Pinned undici `request()` — URL rewritten to `http://pinnedIp/path`, undici `Agent({ connect: { servername: originalHostname } })` preserves TLS SNI (T-02-09); Host header = original hostname — resolve-then-pin, NO second DNS (SEC-02, T-02-04)
8. Response headers lowercased into FetchResult; body as text; `redirectChain: []` (Wave 2 adds redirect following)

---

## Test Coverage

| Test Group | Count | Key Assertions |
|---|---|---|
| dns-resolve unit | 8 | public IP, mixed set poison, empty, metadata, loopback, throw, multi-A, single-call |
| createSafeFetcher happy path | 1 | status 200, lowercase headers, body, empty redirectChain |
| SSRF IP blocks (via resolver) | 4 | 169.254/10.0/127.0/mixed |
| Direct IP literals (e2e) | 6 | 169.254, 127.0.0.1, decimal, octal, hex, IPv4-mapped IPv6 |
| DNS_RESOLUTION_FAILED | 1 | empty resolver |
| Rebinding prevention | 1 | resolver called exactly once (second entry untouched after fetch) |
| Scheme allowlist | 3 | file:, gopher:, data: |
| Port allowlist | 4 | port 22, 6379, 443 (allowed), custom 8080 |
| Userinfo denial | 2 | user:pass@, user@ |
| Loopback test server | 1 | MockAgent seam with real server startup |
| skeleton.test.ts | 5 live + 7 todo | 169.254, 127.0.0.1, 10.0.0.1, file:, javascript: |

**Total: 73 passing, 7 todo (Wave 2/3)**

---

## REVIEWS HIGH Items Satisfied

1. **Single resolution proven** — rebinding test uses `createMockResolver([["1.2.3.4"], ["10.0.0.1"]])`. After a successful fetch, the second entry is still unconsumed, proving the resolver was called exactly once.
2. **No production skip-IP hook** — `_testDispatcher` seam is post-validation only; `resolveAndValidate` runs unconditionally. Blocking tests use real IP literals.
3. **Direct IP literal e2e** — all 6 required URLs tested at fetcher level: `169.254.169.254`, `127.0.0.1`, `2130706433`, `017700000001`, `0x7f000001`, `[::ffff:169.254.169.254]` — all return SSRF_BLOCKED_IP.

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing handling] noUncheckedIndexedAccess guard on `validatedIps[0]`**
- `validatedIps[0]` with `noUncheckedIndexedAccess: true` is `string | undefined`. Added explicit undefined guard returning `DNS_RESOLUTION_FAILED`.

**2. [Rule 1 - Bug] Removed `maxRedirections` from undici request options**
- `maxRedirections` does not exist on undici 8.x `RequestOptions` — caused TS error. Removed (Wave 1 doesn't follow redirects; undici defaults to 0).

**3. [Rule 1 - Bug] MockAgent reply header format**
- `.reply(status, body, headers)` requires `{ headers: {...} }` not `{...}` for the loopback test's `pool.intercept().reply()` call. Fixed test.

### Pre-existing (not fixed)

- `tsconfig.json rootDir: "./src"` causes TS6059 for test helper imports from `packages/fetch/test/helpers/`. Pre-existing from Wave 0. Test files are excluded from the dist build; source files typecheck clean.

---

## Known Stubs

None — Wave 1 goals fully achieved. `redirectChain: []` is intentional (Wave 2). `maxBytes` / `maxRedirects` options accepted but not enforced (Wave 3).

---

## Threat Flags

None — all threat IDs (T-02-04 through T-02-09) are mitigated as specified in the plan's threat register.

---

## Self-Check: PASSED

- `packages/fetch/src/dns-resolve.ts` — EXISTS
- `packages/fetch/src/safe-fetcher.ts` — EXISTS
- `packages/fetch/src/__tests__/dns-resolve.test.ts` — EXISTS
- `packages/fetch/src/__tests__/safe-fetcher.test.ts` — EXISTS
- Commit `ee35c76` (Task 1) — verified in git log
- Commit `3238ecf` (Task 2) — verified in git log
- All 73 tests passing; 7 todo (Wave 2/3)
