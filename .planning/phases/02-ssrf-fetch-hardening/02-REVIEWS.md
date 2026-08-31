---
phase: 2
reviewers: [gemini, codex]
reviewed_at: 2026-06-02
plans_reviewed: [02-00, 02-01, 02-02, 02-03]
verdict: approved with hardening refinements folded into execution
---

# Cross-AI Plan Review — Phase 2

## Gemini Review

The following is a comprehensive review of the Phase 2 (SSRF & Fetch Hardening) implementation plans for the `geo-api` service.

### Summary
Phase 2 produces `@geo/fetch`, a production-hardened URL fetcher that serves as the system's single network gateway. The design prioritizes **deterministic security** over convenience, employing a "resolve-then-pin" strategy to eliminate DNS-rebinding and a manual redirect loop to ensure that every hop is independently validated against the SSRF blocklist. It satisfies the `@geo/core` `Fetcher` contract while providing robust defense against DoS via response-size caps and decompression-bomb (zip bomb) mitigation.

### Strengths
- **DNS-Rebinding Immunity:** The "resolve-then-pin" approach (D-03) is the gold standard for rebinding defense. By ensuring the IP validated is the exact IP used for the socket connection (via `undici` Agent pinning), it eliminates the TOCTOU (Time-of-Check to Time-of-Use) window exploited by TTL-0 DNS swaps.
- **Manual Redirect Validation:** Re-running the full validation suite (scheme, port, IP) on every redirect hop (D-06) correctly mitigates pivot attacks where a public host redirects to an internal one (e.g., `http://public.com` -> `http://169.254.169.254`).
- **Secure IP Classification:** Selecting `ipaddr.js` over the `ip` npm package (which has a known SSRF bypass CVE) is a high-signal security decision. The "default-deny non-global unicast" policy is robust against complex obfuscation like IPv4-mapped IPv6 and octal/hex/decimal IP formats.
- **Decompression-Bomb Defense:** Capping bytes *after* decompression and limiting stacked encodings (D-08) is the correct mitigation for zip bombs, where a small wire payload expands to gigabytes in memory.
- **Environment Robustness:** Proactively identifying and working around Bun's TLS/custom-lookup bug (issue #27890) by using `undici` explicitly ensures the service remains stable across Node and Bun runtimes.

### Concerns
- **DNS Resolver Scope (MED):** The use of `node:dns/promises` (`resolve4`/`resolve6`) bypasses the OS-level resolver (e.g., `/etc/hosts`). While this is **safer** for a security service (prevents local host file manipulation), it may cause unexpected failures in development or CI environments that rely on local aliases. This trade-off is correct but should be clearly documented in the package README.
- **Raw Stream Size Cap (LOW):** The plans emphasize capping *decompressed* bytes. While this prevents zip bombs, a malicious server could still send a massive *raw* incompressible stream (e.g., 100MB of random noise) that bypasses the `maxBytes` cap if the counter is only placed after a decompressor. 
  - *Recommendation:* Ensure the `makeByteCounter` is the first element in the stream pipeline for *all* responses, including those with no compression.
- **SNI/Host Consistency (LOW):** When connecting to an IP directly, the `undici` Agent must be correctly configured with `connect.servername` to match the original hostname for TLS SNI. Failure here will break fetches to virtually all sites behind CDNs (Cloudflare, Akamai). The research notes this (A5), but it remains a common point of implementation failure.

### Suggestions
1. **Defense-in-Depth for Size Caps:** Place a "Raw" byte counter immediately on the incoming stream, and a "Decompressed" counter after the inflation stage. This protects against both large garbage streams and high-ratio bombs.
2. **Explicitly Test Scoped IPv6:** Add unit tests for link-local IPv6 addresses with scope IDs (e.g., `fe80::1%eth0`) to ensure `ipaddr.js` and the validator correctly flag them as blocked.
3. **Validate undici 8.x Interceptor API:** Since the `lookup` callback signature in `undici` interceptors has evolved, the implementation of Wave 1 should start with a source-level verification of `undici/lib/interceptor/dns.js` to ensure the callback shape is handled correctly.
4. **Timeout Enforcements:** Clarify if the 10s timeout (D-10) is a *total* timeout for the entire Fetcher call (all redirects + body read) or a per-hop timeout. An **overall** timeout is strongly recommended to prevent "slow drip" attacks across multiple hops.

### Risk Assessment
- **Security Coverage:** **EXCELLENT.** The plans address all major SSRF and Fetch-based DoS vectors (DNS-rebinding, redirect pivots, IP obfuscation, zip bombs).
- **Correctness Risk:** **MEDIUM.** The primary risk is not a security bypass, but a "correctness" failure where the fetcher is *too* restrictive or fails TLS handshakes due to SNI/Host header mismatches. The TDD approach and loopback test helpers are well-positioned to mitigate this.
- **Implementation Complexity:** **LOW-MEDIUM.** The logic is well-isolated into modular "Wave" plans, making the execution path clear and verifiable.

**Verdict:** The Phase 2 plans are **Approved**. They demonstrate a high level of security maturity and technical foresight.

---

### Final recap of Phase 2 plans:
- **Wave 0:** Infrastructure, pure IP logic, and test helpers.
- **Wave 1:** Core `resolve-then-pin` fetcher with scheme/port/IP blocks.
- **Wave 2:** Manual redirect loop with per-hop re-validation.
- **Wave 3:** Size caps and decompression-bomb defense.

Strategic orchestration of these waves will result in a robust and secure fetch utility that can be safely injected into the `@geo/core` service.

---
**Strategic Orchestration & Finality:**
I have completed the review as requested. I have analyzed the research, context, and detailed plans, providing a structured evaluation of the security architecture. No further changes to the plans are required prior to execution.

update_topic(strategic_intent="Review complete. Plans are validated and ready for implementation.", summary="I have completed a comprehensive review of the Phase 2 (SSRF & Fetch Hardening) plans. The architecture correctly mitigates DNS-rebinding, redirect pivots, and decompression bombs using industry-standard patterns like resolve-then-pin and manual redirect loops. I have provided specific feedback on raw stream caps and SNI consistency to ensure a smooth implementation.")

---

## Codex Review

**Summary**

The plans are directionally strong and cover the right controls: post-DNS IP blocking, resolve-then-pin, manual redirects, size caps, decompression controls, and structured error codes. I would not execute them unchanged, though. The weak points are exactly where SSRF implementations usually fail: the pinned-connect mechanism is still under-specified, the test seam may prove a fake safety property, direct IP literals need end-to-end fetcher tests, and decompression handling needs raw-byte plus decompressed-byte limits with no implicit client decompression.

**Strengths**

- Correctly treats Phase 2 as a prerequisite before any user URL reaches the network.
- Good separation: `@geo/core` stays network-free; `@geo/fetch` owns all network risk.
- Uses the right SSRF primitives: validate all A/AAAA records, deny any blocked record, and manually re-check redirects. This aligns with OWASP guidance to verify resolved IPs and disable automatic redirects.
- `ipaddr.js` is a good choice; it explicitly supports special range classification, extended IPv4 forms, and IPv4-mapped IPv6 conversion.
- Plans include machine-readable errors and focused tests for metadata IPs, obfuscated IPs, redirect pivots, and decompression bombs.

**Concerns**

**HIGH: Resolve-then-pin is not concrete enough.**  
02-01 allows either undici DNS interceptor or direct-IP URL rewriting. Pick one. The plan must prove the checked IP is the connected IP, preserve Host/SNI/cert validation, and avoid connection-pool reuse across different original hostnames. “Resolver called once” is not enough if undici performs a separate internal lookup.

**HIGH: The happy-path test seam can create false confidence.**  
The plan discusses `allowBlockedForTest`, sentinel IPs, or connect overrides to hit a loopback server. That is dangerous unless tightly internal and production-inaccessible. Do not add any skip-IP-check path. Prefer a test transport/connector seam that records the pinned IP and simulates the socket, plus separate blocking tests that use real loopback/private addresses.

**HIGH: Direct IP literals need fetcher-level coverage, not only `isBlockedIP()` unit tests.**  
End-to-end tests should include `http://169.254.169.254/`, `http://127.0.0.1/`, `http://2130706433/`, `http://017700000001/`, `http://0x7f000001/`, and `http://[::ffff:169.254.169.254]/`. If the fetcher only sends hostnames to `resolve4/resolve6`, direct literals may become `DNS_RESOLUTION_FAILED` rather than `SSRF_BLOCKED_IP`, or worse, hit a second resolver path.

**HIGH: Decompression defense is ambiguous.**  
The fetcher must cap both raw wire bytes and decompressed bytes. A final counter after decompression is not enough, and the error code should distinguish identity oversize (`RESPONSE_TOO_LARGE`) from encoded inflation (`DECOMPRESSION_BOMB`). Also ensure the implementation uses `undici.request` without the experimental decompress interceptor; undici documents automatic decompression as a separate interceptor that removes `content-encoding`/`content-length`.

**MED: Redirect tests should cover more bypass shapes.**  
Add protocol-relative `//host/path`, scheme pivots, userinfo in `Location`, IPv6 literals, obfuscated IPv4 literals, missing `Location`, and 307/308. Current redirect tests are good but too narrow for a security gate.

**MED: Timeouts are specified but under-tested.**  
Add DNS timeout, connect timeout, header timeout, and slow body drip tests. Otherwise a server can avoid size caps by never finishing.

**MED: SEC-05 job-level failure is out of phase.**  
Phase 2 can only return structured `FetchResult.error`; job-level `failed` status is Phase 4. Add a documented adapter contract or a small phase-gate fixture so this success criterion does not get lost.

**LOW: Error model may be too flat.**  
`error: string` is compatible with `@geo/core`, but redirect failures would benefit from retaining an internal cause like `SSRF_BLOCKED_IP` while surfacing `REDIRECT_BLOCKED`.

**Suggestions**

- Amend 02-01 to mandate one pinned-connect strategy and add a test that fails if `dns.lookup` or any unapproved resolver is called after validation.
- Add direct URL literal end-to-end tests in 02-01, not just IP classifier tests.
- For HTTPS, add a TLS fixture or smoke test proving SNI/certificate verification uses the original hostname. The Bun custom-lookup issue I found is now marked closed, but it still supports keeping the plan on explicit undici plus a runtime smoke test.
- In 02-03, implement two counters: raw response bytes before decompression and decompressed bytes after each decompression layer/final output.
- Add defense-in-depth outside code: container egress rules blocking RFC1918, loopback, link-local, ULA, metadata, CGNAT/reserved ranges. App-layer SSRF controls should not be the only barrier.

**Risk Assessment**

Current plan risk: **Medium-High**. The requirements are correct, but a small mistake in pinned connection or implicit decompression can fully defeat the phase.

After the amendments above: **Medium-Low**. Residual risk remains around HTTP client behavior, TLS/SNI edge cases, and future dependency changes, so keep the fetcher package small, heavily tested, and isolated as the only outbound URL path.

---

## Consensus Summary

Both reviewers approve the architecture (resolve-then-pin, manual per-hop redirect re-validation, ipaddr.js over the CVE-bearing `ip` pkg, decompression-bomb defense). Codex rates residual risk Medium-High until refinements land, Medium-Low after. The following are FOLDED INTO EXECUTION (passed to executors), not deferred:

### HIGH (both/Codex) — must implement
1. **Pin concreteness:** choose ONE resolve-then-pin strategy; add a test that FAILS if any DNS lookup/resolver runs AFTER validation (prove checked IP === connected IP). Preserve Host header + TLS SNI servername + cert verification against the ORIGINAL hostname.
2. **No skip-IP-check test seam:** never add an `allowBlockedForTest`/skip path reachable in production. Use a transport/connector seam that records the pinned IP and simulates the socket; blocking tests use REAL loopback/private addresses.
3. **Direct IP literal e2e tests at the fetcher level** (not just isBlockedIP unit): `http://169.254.169.254/`, `http://127.0.0.1/`, `http://2130706433/`, `http://017700000001/`, `http://0x7f000001/`, `http://[::ffff:169.254.169.254]/` — each must return `SSRF_BLOCKED_IP`, NOT `DNS_RESOLUTION_FAILED`.
4. **Two-counter size defense:** cap RAW wire bytes (→ `RESPONSE_TOO_LARGE`) AND decompressed bytes (→ `DECOMPRESSION_BOMB`), distinct codes. Do NOT enable undici's auto-decompress interceptor (it strips content-encoding/length); decompress manually with the counting Transform. Raw counter is FIRST in the pipeline for all responses (incl. identity).

### MED — fold in where cheap
- Redirect bypass shapes: protocol-relative `//host`, scheme pivot, userinfo in Location, IPv6 literal, obfuscated IPv4 literal, missing Location, 307/308.
- Timeout sub-tests: DNS, connect, header, slow-body-drip; the 10s is an OVERALL budget across all hops + body, not per-hop.
- Scoped link-local IPv6 (`fe80::1%eth0`) blocked test.
- SEC-05: Phase 2 returns structured `FetchResult.error` only; job-level `failed` mapping is Phase 4 — document the adapter contract so the criterion isn't lost.

### Divergent / out-of-code
- Gemini: `node:dns` bypasses /etc/hosts (safer for a security service) — document in README.
- Codex: add container egress firewall (RFC1918/loopback/link-local/ULA/CGNAT/metadata) as defense-in-depth — note for Phase 6 deploy, app-layer is not the only barrier.
