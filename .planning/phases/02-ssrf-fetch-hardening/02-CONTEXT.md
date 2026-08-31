# Phase 2: SSRF & Fetch Hardening - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a hardened URL fetcher that is the SINGLE network entry point for the system and satisfies the `Fetcher`/`FetchResult` contract defined by `@geo/core` in Phase 1 (decision D-05). It must block SSRF (private/loopback/link-local/ULA/cloud-metadata IPs), be DNS-rebinding safe (resolve-then-pin), re-validate every redirect hop, enforce a response-size cap, and be decompression-bomb safe — failing every unsafe fetch with a structured, machine-readable error.

Covers SEC-01 … SEC-05. Does NOT include: persistence (Phase 3), the worker pipeline or scoring (Phase 4), or the HTTP API surface (Phase 5). It also does NOT change `@geo/core` (which stays zero-dep and network-free) — this is a separate package that @geo/core consumes via injection.
</domain>

<decisions>
## Implementation Decisions

### Package & contract
- **D-01:** Lives as a separate workspace package `packages/fetch/` (e.g. `@geo/fetch`). Unlike `@geo/core` it MAY have runtime deps, but prefer Node/Bun built-ins (`node:dns/promises`, `node:net`, global `fetch`/undici) to minimize surface. (recommended)
- **D-02:** Exports a `createSafeFetcher(options)` factory returning a function that conforms EXACTLY to `@geo/core`'s `Fetcher` type and returns its `FetchResult` (lowercased headers, `redirectChain`, `error?`). The geo-api worker injects this into `@geo/core`. (recommended — this is the Phase-1↔2 seam)

### SSRF / DNS-rebinding
- **D-03:** Resolve the hostname to all A/AAAA records FIRST, validate EVERY resolved IP against the blocklist, then **pin** the connection to a validated IP (connect-by-IP with the original `Host`/SNI preserved) so the address checked == the address connected. This defeats DNS rebinding. (recommended)
- **D-04:** Blocklist (deny) covers: loopback (127.0.0.0/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16 incl. **169.254.169.254** cloud metadata, fe80::/10), unspecified (0.0.0.0, ::), broadcast/multicast, and IPv4-mapped IPv6 forms of the above. Default-deny non-global ranges. (recommended)
- **D-05:** Scheme allowlist: `http`/`https` only. Reject `file:`, `ftp:`, `gopher:`, `data:`, etc. Optional port allowlist (80/443 by default, configurable). (recommended)

### Redirects
- **D-06:** Manual redirect following (`redirect: 'manual'`), capped at a max hop count (default 5). Re-run the full SSRF+DNS-pin validation on EACH hop's target before connecting. Record every hop in `redirectChain`. A hop to a blocked address fails the fetch at that step. (recommended)

### Size / decompression
- **D-07:** Stream the response body with a running byte counter; abort + fail when it exceeds `maxBytes` (default ~5 MB, configurable — aligns with @geo/core's 5MB parse guard). Also honor `Content-Length` early-reject. (recommended)
- **D-08:** Decompression-bomb safe: cap DECOMPRESSED bytes (not just compressed), reject when the inflate ratio/size exceeds the cap; bound the number of stacked content-encodings. (recommended)

### Error model
- **D-09:** Every failure returns a structured result (NOT a thrown stack) carrying a machine-readable `code` from a fixed enum: `SSRF_BLOCKED_IP`, `SSRF_BLOCKED_SCHEME`, `SSRF_BLOCKED_PORT`, `DNS_RESOLUTION_FAILED`, `REDIRECT_BLOCKED`, `TOO_MANY_REDIRECTS`, `RESPONSE_TOO_LARGE`, `DECOMPRESSION_BOMB`, `CONNECT_TIMEOUT`, `FETCH_ERROR`. The worker (Phase 4) maps this to a job-level `failed` status with the code surfaced (SEC-05). (recommended)
- **D-10:** A connect/overall timeout (default ~10s) bounds every fetch. (recommended)

### Testing
- **D-11:** Vitest. Unit-test IP classification with a table of CIDR cases (incl. IPv4-mapped IPv6 + 169.254.169.254). Integration-test rebinding (mock resolver returning private IP after a public one), redirect-to-private (local test server issuing 302→private), oversize + decompression-bomb (gzip ratio) using a loopback test server. (recommended)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project / requirements
- `.planning/REQUIREMENTS.md` §"Security / Fetch Hardening" — SEC-01..05
- `.planning/ROADMAP.md` — Phase 2 goal + success criteria
- `.planning/PROJECT.md` — SSRF-prerequisite constraint

### Phase 1 contract (the seam this phase fills)
- `packages/core/src/types.ts` — `Fetcher` / `FetchResult` contract that `createSafeFetcher` MUST satisfy
- `.planning/phases/01-geo-core-deterministic-package/01-CONTEXT.md` D-05 — injected-fetch decision
- `.planning/phases/01-geo-core-deterministic-package/01-06-SUMMARY.md` — final public surface of @geo/core

### Codebase / prior art
- `scripts/fetch_page.py` — existing (unhardened) fetch behavior + `.planning/codebase/CONCERNS.md` (the SSRF + no-size-cap findings this phase remediates)

### External
- OWASP SSRF Prevention Cheat Sheet — blocklist/allowlist + DNS-rebinding guidance

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@geo/core` `Fetcher`/`FetchResult` types (Phase 1) — the exact contract to implement.
- `AI_CRAWLERS`, result types from @geo/core — unaffected; this phase only supplies the fetch implementation.

### Established Patterns
- Structured result objects with machine-readable codes (mirrors @geo/core D-06 no-throw-for-expected-failure model).

### Integration Points
- Phase 4 worker injects `createSafeFetcher()` into `@geo/core` functions (checkRobots, etc.).
- Phase 5 API reuses the SAME fetcher to SSRF-check `callback_url` webhooks (API-08).

</code_context>

<specifics>
## Specific Ideas

Resolve-then-pin is the non-negotiable core: the IP validated must be the IP connected to (no second resolution). Cloud-metadata 169.254.169.254 is the canonical attack target — it has an explicit test. Size cap aligns with @geo/core's 5 MB parse guard so a fetched body never exceeds what the parsers were hardened for.
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Per-consumer rate limiting → v2 OPS-01; webhook callback SSRF check is wired in Phase 5 but reuses this fetcher.)
</deferred>

---

*Phase: 2-SSRF & Fetch Hardening*
*Context gathered: 2026-06-02*
