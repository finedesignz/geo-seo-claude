---
phase: 02-ssrf-fetch-hardening
plan: "00"
subsystem: "@geo/fetch"
tags: [ssrf, ip-validation, error-model, test-infra, security]
dependency_graph:
  requires: ["@geo/core (FetchResult/Fetcher types)"]
  provides: ["@geo/fetch scaffold", "isBlockedIP()", "FetchErrorCode", "buildErrorResult()", "createTestServer()", "createMockResolver()"]
  affects: ["02-01-ssrf-network (Wave 1 createSafeFetcher)", "02-02+ integration tests"]
tech_stack:
  added: ["ipaddr.js 2.4.0", "undici 8.3.0"]
  patterns: ["const-object error enum", "fail-closed IP deny (range !== unicast)", "IPv4-mapped IPv6 unwrap", "loopback test-server on :0", "sequence-based mock resolver"]
key_files:
  created:
    - packages/fetch/package.json
    - packages/fetch/tsconfig.json
    - packages/fetch/tsup.config.ts
    - packages/fetch/vitest.config.ts
    - packages/fetch/src/index.ts
    - packages/fetch/src/errors.ts
    - packages/fetch/src/ip-validator.ts
    - packages/fetch/src/__tests__/ip-validator.test.ts
    - packages/fetch/src/__tests__/skeleton.test.ts
    - packages/fetch/test/helpers/test-server.ts
    - packages/fetch/test/helpers/mock-resolver.ts
  modified: [bun.lock]
decisions:
  - "isBlockedIP strategy: deny anything whose ipaddr.js range() !== 'unicast' (default-deny non-global, D-04)"
  - "IPv4-mapped IPv6 unwrapped via isIPv4MappedAddress()+toIPv4Address() before range check (T-02-01)"
  - "FetchErrorCode as const object (not enum) to avoid TS const-enum cross-module pitfall"
  - "skeleton e2e tests as it.todo() so suite stays green this wave while recording Wave 1 contract"
  - "createMockResolver exhausts-and-throws to make missing-entry test failures obvious"
metrics:
  duration: "~10 min"
  completed: "2026-06-02"
  tasks_completed: 2
  files_created: 11
  tests_passing: 37
  tests_todo: 12
---

# Phase 2 Plan 00: @geo/fetch Wave 0 Scaffold Summary

**One-liner:** `@geo/fetch` workspace package with ipaddr.js SSRF IP classifier (SEC-01), 10-code error model (SEC-05), loopback test-server + mock-resolver infra for Wave 1+ integration tests — 37/37 IP-validator assertions green.

## Tasks Completed

| # | Task | Commit | Result |
|---|------|--------|--------|
| 1 | Scaffold @geo/fetch package + install deps | 245b816 | tsc --noEmit clean, undici+ipaddr.js+@geo/core resolved |
| 2 | errors.ts + ip-validator.ts + test infra | 4c47175 | 37 tests pass, 12 todos recorded |

## Verification Results

- `bun run --cwd packages/fetch test -- --run`: **37 passed, 12 todo** (skeleton todos are `it.todo`, intentionally pending)
- `bunx tsc --noEmit -p packages/fetch/tsconfig.json`: **exit 0**
- `bun run --cwd packages/core test -- --run`: **106 passed** (unchanged, no regression)
- No `ip` npm package in dependency tree (banned CVE package)

## IP Classifier Coverage (SEC-01)

All required BLOCKED cases confirmed green:
- Loopback: `127.0.0.1`, `127.255.255.255`
- Private: `10.x`, `172.16-31.x`, `192.168.x`
- Link-local/cloud-metadata: `169.254.169.254`, `169.254.1.1`
- Unspecified: `0.0.0.0`, `::`
- Broadcast: `255.255.255.255`
- IPv6: `::1`, `fc00::1`, `fd00::1`, `fe80::1`, `fe80::1%eth0`
- IPv4-mapped IPv6 (T-02-01): `::ffff:169.254.169.254`, `::ffff:127.0.0.1`
- Obfuscated (T-02-02): `2130706433` (decimal), `017700000001` (octal), `0x7f000001` (hex)
- Garbage/unparseable: deny-by-default

ALLOWED public unicast: `8.8.8.8`, `1.1.1.1`, `2606:4700:4700::1111`

## Error Model (SEC-05)

`FetchErrorCode` exports exactly 10 codes: `SSRF_BLOCKED_IP`, `SSRF_BLOCKED_SCHEME`, `SSRF_BLOCKED_PORT`, `DNS_RESOLUTION_FAILED`, `REDIRECT_BLOCKED`, `TOO_MANY_REDIRECTS`, `RESPONSE_TOO_LARGE`, `DECOMPRESSION_BOMB`, `CONNECT_TIMEOUT`, `FETCH_ERROR`.

`buildErrorResult(url, code, redirectChain?)` returns FetchResult-shaped object: `status:0`, `headers:{}`, `body:""`, `error: code`. Never throws.

## Test Infrastructure

- `createTestServer(handler)` — `node:http` server bound to `127.0.0.1:0`, resolves `{server, url, port, close()}`.
- `createMockResolver(sequence)` — pops next address array per call; throws on exhaustion to catch missing test setup early.
- `createStaticResolver(addresses)` — convenience variant for non-rebinding tests.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

- `src/__tests__/skeleton.test.ts` — 12 `it.todo()` tests for Wave 1 `createSafeFetcher`. Intentional: records contract before network code exists. Wave 1 (02-01) will implement and unskip.

## Threat Flags

None. All T-02-0x mitigations applied: IPv4-mapped unwrap (T-02-01), obfuscated-IP tests (T-02-02), cloud-metadata link-local deny (T-02-03). Package legitimacy pre-approved in RESEARCH (T-02-SC).

## Self-Check: PASSED

- packages/fetch/src/ip-validator.ts: FOUND
- packages/fetch/src/errors.ts: FOUND
- packages/fetch/src/__tests__/ip-validator.test.ts: FOUND
- packages/fetch/test/helpers/test-server.ts: FOUND
- packages/fetch/test/helpers/mock-resolver.ts: FOUND
- Commit 245b816: FOUND
- Commit 4c47175: FOUND
