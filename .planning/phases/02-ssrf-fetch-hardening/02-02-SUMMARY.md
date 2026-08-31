---
phase: 02-ssrf-fetch-hardening
plan: "02"
subsystem: fetch
tags: [ssrf, redirect, security, sec-03, sec-02, sec-05]
dependency_graph:
  requires: ["02-01"]
  provides: ["manual-redirect-loop", "per-hop-ssrf-validation", "redirect-chain"]
  affects: ["packages/fetch/src/safe-fetcher.ts"]
tech_stack:
  added: []
  patterns: ["manual redirect loop", "resolve-then-pin per hop", "REDIRECT_BLOCKED on pivot"]
key_files:
  created:
    - packages/fetch/src/__tests__/redirect.test.ts
  modified:
    - packages/fetch/src/safe-fetcher.ts
decisions:
  - "Extracted validateUrl() internal helper to avoid duplicating scheme/port/userinfo/DNS logic per hop"
  - "undici request() defaults to 0 auto-redirections; no explicit option needed"
  - "REDIRECT_BLOCKED used for any hop-target validation failure (not raw SSRF code) per plan spec"
  - "Redirect cap enforced after pushing to redirectChain so chain.length === maxRedirects on TOO_MANY_REDIRECTS"
metrics:
  duration: "~15 minutes"
  completed: "2026-06-02"
  tasks_completed: 1
  files_modified: 2
---

# Phase 02 Plan 02: Manual Redirect Loop with Per-Hop SSRF Re-validation Summary

Manual redirect following (redirect:'manual') added to createSafeFetcher with full SSRF re-validation on every hop, hop cap, and redirectChain recording (SEC-03, SEC-02, SEC-05).

## What Was Built

Refactored `safe-fetcher.ts` Wave 1 single-request core into a `validateUrl()` internal helper, then wrapped it in a manual redirect loop. Each hop:

1. Calls `validateUrl()` — full scheme → port → userinfo → resolve-then-pin validation
2. Issues `request()` with undici (default 0 auto-redirections)
3. On 3xx: pushes `{url, status}` to `redirectChain`, resolves `new URL(location, currentUrl)` for relative/protocol-relative Location, increments hop counter, loops
4. Hop count ≥ `maxRedirects` (default 5) → `TOO_MANY_REDIRECTS`
5. Hop-target validation failure on redirect → `REDIRECT_BLOCKED` (carries chain)

## Tests Added

13 new tests in `redirect.test.ts` covering:

- 302 → 200 chain with correct `redirectChain` entry
- Hop cap: self-redirect loop → `TOO_MANY_REDIRECTS`, `redirectChain.length === 5`
- Pivot to private IP (10.0.0.1) → `REDIRECT_BLOCKED`
- Pivot to metadata IP (169.254.169.254) → `REDIRECT_BLOCKED`
- Relative Location (`/path`) → resolved correctly, re-validated
- Missing Location on 3xx → `FETCH_ERROR`
- 307 redirect followed correctly
- 308 redirect followed correctly
- Userinfo in Location (`user:pass@host`) → `REDIRECT_BLOCKED`
- IPv6 literal `[::1]` → `REDIRECT_BLOCKED`
- Obfuscated IPv4 decimal integer → blocked (error defined, status 0)
- Protocol-relative Location (`//host/path`) → resolved to same scheme, allowed
- 2-hop chain ordering preserved

## Deviations from Plan

**1. [Rule 1 - Bug] Removed non-existent `maxRedirections` option from undici request()**
- Found during: TypeScript check
- Issue: `maxRedirections` does not exist on undici `request()` options type; undici's default behavior already sends 0 auto-redirections
- Fix: Removed the option; added comment explaining default behavior
- Files modified: `packages/fetch/src/safe-fetcher.ts`
- Commit: 3b85a41 (same task commit)

## Security Coverage

| Threat | Status |
|--------|--------|
| T-02-10 Redirect pivot public→private/metadata | Mitigated — REDIRECT_BLOCKED + tests |
| T-02-11 Redirect TOCTOU (re-resolve each hop) | Mitigated — validateUrl() called per hop |
| T-02-12 Infinite redirect loop (DoS) | Mitigated — TOO_MANY_REDIRECTS cap + test |
| T-02-13 Relative Location masking target | Mitigated — new URL(location, base) normalization |

## Verification

- `bun run --cwd packages/fetch test -- --run`: 86 passed, 7 todo (all 5 test files)
- `grep -q "manual" packages/fetch/src/safe-fetcher.ts`: passes (comment present)
- TypeScript: no new errors (2 pre-existing rootDir errors in test imports unrelated to this plan)

## Self-Check: PASSED

- `packages/fetch/src/safe-fetcher.ts`: exists, modified
- `packages/fetch/src/__tests__/redirect.test.ts`: exists, created
- Commit `3b85a41`: present in git log
