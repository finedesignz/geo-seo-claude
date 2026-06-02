---
phase: 2
slug: ssrf-fetch-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-02
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `packages/fetch/vitest.config.ts` (Wave 0 installs) |
| **Quick run command** | `bun run --cwd packages/fetch test -- --run` |
| **Full suite command** | `bun run --cwd packages/fetch test -- --run && bun run --cwd packages/core test -- --run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun run --cwd packages/fetch test -- --run`
- **After every plan wave:** Run full suite + `bun run --cwd packages/fetch build`
- **Before verify:** Full suite green; `createSafeFetcher` conforms to `@geo/core` `Fetcher` type (tsc clean)
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 2-00-01 | 00 | 0 | infra | — | package scaffold + Fetcher type conformance | infra | `bun run --cwd packages/fetch test -- --run` | ❌ W0 | ⬜ pending |
| 2-01-01 | 01 | 1 | SEC-01 | T-SSRF-IP | private/loopback/link-local/metadata IPs blocked post-DNS | unit | `bun run --cwd packages/fetch test ip` | ❌ W0 | ⬜ pending |
| 2-02-01 | 02 | 1 | SEC-02 | T-REBIND | resolve-then-pin; rebinding TOCTOU blocked | integration | `bun run --cwd packages/fetch test rebind` | ❌ W0 | ⬜ pending |
| 2-03-01 | 03 | 2 | SEC-03 | T-REDIRECT | each redirect hop re-validated; pivot-to-private blocked | integration | `bun run --cwd packages/fetch test redirect` | ❌ W0 | ⬜ pending |
| 2-04-01 | 04 | 2 | SEC-04 | T-OVERSIZE/T-ZIPBOMB | size cap + decompression-bomb fail cleanly | integration | `bun run --cwd packages/fetch test size` | ❌ W0 | ⬜ pending |
| 2-05-01 | 05 | 2 | SEC-05 | — | structured machine-readable error code on every block | unit | `bun run --cwd packages/fetch test errors` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/fetch/package.json` (+ `@geo/fetch`, depends on `@geo/core` for the type contract)
- [ ] `packages/fetch/vitest.config.ts`
- [ ] `ipaddr.js` dependency installed (verified non-CVE IP classifier per research)
- [ ] `undici` available for HTTPS + custom lookup (Bun built-in fetch HTTPS+lookup is broken per research)
- [ ] loopback test-server + mock-resolver test helpers

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real cloud-metadata endpoint unreachable | SEC-01 | Cannot hit real 169.254.169.254 in CI safely | Covered by IP-classification unit test (deny 169.254.169.254) — no live call needed |

*All phase behaviors have automated verification via loopback servers + mock resolver.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
