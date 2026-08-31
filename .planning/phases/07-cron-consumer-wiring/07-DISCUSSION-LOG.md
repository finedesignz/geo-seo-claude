# Phase 7: Cron + Consumer Wiring — Discussion Log

**Mode:** `--auto` (fully autonomous; recommended option chosen for every gray area; `AskUserQuestion` never invoked)
**Date:** 2026-06-04

## Inputs loaded
- `.planning/ROADMAP.md` §Phase 7, `.planning/REQUIREMENTS.md` (DEPLOY-02, CONS-01, CONS-02), `.planning/PROJECT.md`, `.planning/STATE.md`.
- Prior phases: `06-CONTEXT.md` / `06-DEPLOY-RECORD.md` (DEFERRED-LIVE pattern, one-image-N-run-targets, env-secrets D-07), `05` API layer.
- Code scout: `packages/core/src/index.ts` (zero-dep barrel, no `node:` imports), `packages/api/src/routes/audit-post.ts` (body `{url,callback_url?}`, `DEDUP_TTL_MS=1h`, consumer-scoped dedup, **no force flag**), `audit-get.ts` (`{status,score?,findings?,error_code?}`, ownership-scoped 404), `middleware/auth.ts` (`GEO_API_KEYS` token:consumer_id bearer), `docs/deploy.md` (no cron section yet).

## Ground-truth constraints applied
- Session confined to geo-seo-claude (rule 20) → HOW + ottolax repo edits are cross-repo, out of scope.
- Live cron firing + live ottolax round-trip depend on deployed geo-api → DEFERRED-LIVE (Phase 6 gate unmet).
- Criterion 2 (`@geo/core` inline) fully testable now (pure import).

## Gray areas → recommended decision (rationale in CONTEXT §decisions)
| # | Gray area | Decision |
|---|-----------|----------|
| D-1 | Cron container vs scheduler-mode of existing image; Coolify cron vs in-container loop | Cron entry point off the SAME image, run as a Coolify scheduled task (one-shot fire-then-exit); in-container loop only as fallback |
| D-2 | URL-list + schedule config source | Env-driven: `CRON_TARGET_URLS`, `CRON_SCHEDULE`, `CRON_API_TOKEN`, `GEO_API_BASE_URL` (12-factor) |
| D-3 | Re-audit cadence vs 1h dedup TTL / force flag | No force flag added; cadence constrained > 1h (≥ daily default) so dedup never suppresses a scheduled re-audit |
| D-4 | Cron auth | Dedicated `GEO_API_KEYS` consumer entry (`cron` consumer_id) → isolated re-audit history |
| D-5 | CONS-01 in-repo vs cross-repo | Runnable `examples/how-inline-usage.ts` + vitest test + dep doc NOW; HOW's actual `package.json` wiring is cross-repo |
| D-6 | CONS-02 in-repo vs cross-repo | `examples/ottolax-client.py` + `docs/consumers.md` contract NOW; ottolax repo wiring is cross-repo |
| D-7 | Testable-now vs DEFERRED-LIVE | C2 proven now (test); C1 code+unit-tested now, live deferred; C3 client+contract now, live deferred |
| D-8 | Cron HTTP client | Plain `fetch` to `${GEO_API_BASE_URL}/audit`, not `@geo/api` internals |

## Key findings that shaped decisions
- `POST /audit` body is exactly `{url, callback_url?}` — **no force flag exists**; adding one is an out-of-scope API change → D-3 avoids it by cadence.
- `DEDUP_TTL_MS = 60*60*1000` is **hardcoded** in `audit-post.ts` (not env-driven) → cadence constraint is the only lever without code change.
- `@geo/core` `src/` has **no `node:` imports** → inline import is pure/network-free, criterion 2 provable in a unit test.
- Dedup + job ownership are **consumer-scoped** → cron and ottolax each need their own `GEO_API_KEYS` consumer_id.
- No `examples/` code dir or cron package exists yet; `docs/deploy.md` has no cron section → all are new artifacts.

## Outcome
`07-CONTEXT.md` written; ready for planning. No source code or other repos edited (discuss-phase only).
