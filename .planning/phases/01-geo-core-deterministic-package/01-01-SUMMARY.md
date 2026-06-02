---
phase: 01-geo-core-deterministic-package
plan: "01"
subsystem: "@geo/core"
tags: [robots-txt, fetch-injection, ai-crawlers, tdd, vitest]
dependency_graph:
  requires: ["01-00 (walking skeleton — Fetcher seam, AI_CRAWLERS, type stubs)"]
  provides: ["checkRobots(siteUrl, fetcher)", "CrawlerStatus type", "full RobotsResult shape"]
  affects: ["packages/core/src/robots.ts", "packages/core/src/types.ts", "packages/core/src/index.ts"]
tech_stack:
  added: []
  patterns: ["fetch-injection (D-05)", "result-accumulation error model (D-06)", "line-by-line parser (T-01-R1 DoS guard)"]
key_files:
  created:
    - packages/core/src/robots.ts
    - packages/core/src/__tests__/robots.test.ts
  modified:
    - packages/core/src/types.ts
    - packages/core/src/index.ts
decisions:
  - "RobotsResult extended with exists/content/aiCrawlerStatus/sitemaps; old crawlability/sitemapUrls fields replaced"
  - "Sitemap URLs validated via new URL() — never string-concatenated (Pitfall-4 fix)"
  - "Blank-line group termination implemented per RFC 9309 §2.1"
  - "Multiple consecutive User-agent lines before rules treated as one group"
  - "Empty Disallow: = allow all (RFC 9309 §2.2.3)"
  - "404 and all non-2xx treated as missing robots.txt with empty errors (D-06)"
metrics:
  duration: "~20 minutes"
  completed: "2026-06-02"
  tasks_completed: 1
  files_created: 2
  files_modified: 2
  commits: 1
requirements_shipped: [CORE-01]
---

# Phase 1 Plan 01: checkRobots Summary

**One-liner:** robots.txt parser with per-AI-crawler status (BLOCKED/ALLOWED/wildcards), sitemap extraction via `new URL()` validation (Pitfall-4 bug fix), and fetcher-injection seam.

## What Was Built

1. **`packages/core/src/robots.ts`** — `checkRobots(siteUrl, fetcher)` implementing:
   - Input validation via `new URL()` before any fetch call (V5).
   - Fetcher call + 404/non-2xx → `exists:false`, all `NO_ROBOTS_TXT`, `errors:[]`.
   - Line-by-line parser: groups, blank-line termination, CRLF, comments, case-insensitive.
   - Per-AI-crawler status: BLOCKED / PARTIALLY_BLOCKED / ALLOWED / BLOCKED_BY_WILDCARD / ALLOWED_BY_DEFAULT / NOT_MENTIONED / NO_ROBOTS_TXT.
   - Sitemap extraction with `new URL()` validation — rejects malformed values silently.

2. **`packages/core/src/__tests__/robots.test.ts`** — 18 vitest tests covering all status paths, sitemap bug-fix, CRLF, comments, empty Disallow, invalid URL, URL construction.

3. **`packages/core/src/types.ts`** — `RobotsResult` extended with `exists`, `content`, `aiCrawlerStatus: Record<AiCrawler, CrawlerStatus>`, `sitemaps`; `CrawlerStatus` union type added.

4. **`packages/core/src/index.ts`** — `checkRobots` and `CrawlerStatus` re-exported from barrel.

## Verification

- `bun run --cwd packages/core test -- --run robots` — 18/18 green
- `bun run --cwd packages/core test -- --run` — 22/22 green (full suite)
- No network imports in `packages/core/src/`
- `checkRobots` importable from `@geo/core` barrel

## Deviations from Plan

None — plan executed exactly as written. The `RobotsResult` stub from Plan 00 was replaced with the full shape defined in RESEARCH.md (expected deviation; stubs are intentional placeholders).

## Threat Surface Scan

No new network surface introduced. `@geo/core` remains zero-I/O; the injected fetcher is unchanged.

| Threat ID | Status |
|-----------|--------|
| T-01-R1 (DoS — line parser) | Mitigated: line-by-line split, no full-body regex |
| T-01-R2 (sitemap URL tampering) | Mitigated: `new URL()` validation, http/https only |
| T-01-R3 (SSRF) | Transferred to Phase 2 fetcher as designed |

## Self-Check: PASSED

- `packages/core/src/robots.ts` — present
- `packages/core/src/__tests__/robots.test.ts` — present
- Commit `13aff3c` — verified in git log
- 22/22 tests green at commit time
