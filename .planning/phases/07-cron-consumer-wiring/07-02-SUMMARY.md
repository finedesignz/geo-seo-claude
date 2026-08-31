---
phase: 07-cron-consumer-wiring
plan: 02
subsystem: deploy
tags: [cron, deploy, dockerfile, env, runbook, role-by-command]
requires:
  - "@geo/cron one-shot caller (dist/main.js) from 07-01"
  - "single multi-stage Dockerfile (role-by-command, D-01/D-03) from Phase 6"
provides:
  - "cron run target builds into the single image (manifest copied in deps stage)"
  - "DEPLOY-02 deployability: Coolify Scheduled-Task runbook + <1h cadence guidance"
  - "DEPLOY-03 env contract: CRON_* vars + :cron/:ottolax consumer key placeholders"
affects:
  - "Dockerfile (deps stage manifest copy + header)"
  - ".env.example (CRON block + GEO_API_KEYS consumer entries)"
  - "docs/deploy.md (fourth run target + cron runbook)"
tech-stack:
  added: []
  patterns:
    - "role-by-command: no new build stage/CMD; existing `bun run --filter '*' build` + `COPY --from=build /app/packages` ship dist/main.js automatically"
    - "secrets injected via Coolify env (D-07); .env.example carries placeholders only"
key-files:
  created:
    - .planning/phases/07-cron-consumer-wiring/07-02-SUMMARY.md
  modified:
    - Dockerfile
    - .env.example
    - docs/deploy.md
decisions:
  - "Only the one COPY line + header/comment updates in Dockerfile — no new stage, no CMD change; cron dist ships via the existing build+copy chain"
  - "Env var names cross-checked against packages/cron/src/env.ts: CRON_TARGET_URLS/CRON_API_TOKEN/GEO_API_BASE_URL required, CRON_SCHEDULE informational (Coolify field is the real clock)"
  - "<1h cadence warning framed as a hard constraint (DEDUP_TTL 1h, no force flag per D-3); default `0 4 * * *` daily is safe"
  - "Live scheduled firing kept DEFERRED-LIVE (Phase 6 operator gate), captured as user_setup + a deploy.md callout"
metrics:
  duration: ~8 min
  completed: 2026-06-04
---

# Phase 7 Plan 02: Cron Run Target + Scheduled-Task Runbook Summary

One-liner: made `@geo/cron` a real fourth run target off the existing single image (manifest copied into the deps stage — no new stage/CMD) and documented the full operator contract: `.env.example` CRON block + `:cron`/`:ottolax` consumer keys, and a `docs/deploy.md` Coolify Scheduled-Task runbook with the mandatory <1h cadence-vs-dedup warning, UTC note, and DEFERRED-LIVE callout.

## What Was Built

- **Dockerfile** — added `COPY packages/cron/package.json ./packages/cron/package.json` to the `deps` stage manifest block (so `bun install --frozen-lockfile` resolves the package and `bun run --filter '*' build` builds `packages/cron/dist/main.js`, which the existing `COPY --from=build /app/packages` already ships). Header role comment gained a fourth line (`Cron (scheduled task) : bun packages/cron/dist/main.js`); build comment bumped 5 → 6 tsup packages. **No new build stage, no CMD change** — role-by-command preserved (API default CMD + worker/migrate/cron overrides intact).
- **.env.example** — new `# === CRON / SCHEDULED RE-AUDIT (Phase 7) ===` block documenting `CRON_TARGET_URLS` (two placeholder http(s) URLs), `CRON_API_TOKEN` (placeholder, must equal the `:cron` token), `GEO_API_BASE_URL` (default `http://localhost:8080`), and `CRON_SCHEDULE` (`0 4 * * *`, UTC, <1h constraint cross-referenced). Extended the `GEO_API_KEYS` comment with a placeholder example showing `:cron` and `:ottolax` consumer entries and why each consumer is dedup-scoped. Var names verified against `packages/cron/src/env.ts`.
- **docs/deploy.md** — (a) renamed "three run targets" → "four", added a `| Cron | bun packages/cron/dist/main.js | none | one-shot (Scheduled Task) |` row. (b) New `## Cron / scheduled re-audit (DEPLOY-02)` section: register a Coolify Scheduled Task on the geo-api resource (`[HUMAN GATE]`); env + `:cron` GEO_API_KEYS table; a loud ⚠️ <1h cadence-vs-DEDUP_TTL warning (no force flag, Pitfall 1); UTC/timezone note (Pitfall 2); enqueue-only/overlap-unlikely note (Pitfall 4); and a DEFERRED-LIVE callout (live firing + jobs-in-history verified post-deploy, mirroring Phase 6), referencing `scripts/deploy-verify.sh` and keeping `/openapi.json` as the contract source of truth.

## Verification Results

- `grep -q packages/cron/package.json Dockerfile` → OK; no `FROM ... AS` stage added, default `CMD ["bun","packages/api/dist/main.js"]` unchanged.
- `grep CRON_TARGET_URLS .env.example` + `grep -i "Scheduled Task" docs/deploy.md` + cadence-warning grep → VERIFY_OK (the plan's Task 2 automated check).
- Manifest-copy consistency: deps stage now copies core/fetch/db/api/worker/cron package.json (6, matching the 6 built packages).
- Secret safety: only `REPLACE_ME_*` / `example.com` placeholders in `.env.example`; deploy.md uses `<cron-token>` / `<...>` placeholders and `[HUMAN GATE]` markers — no real token or UUID committed (T-07-05 mitigated).

## Deviations from Plan

None of substance. Two surgical additions beyond the literal task text, both consistency-driven (Rule 1/2 housekeeping):
- Bumped the Dockerfile build-stage comment from "5 tsup packages" to "6" (stale after adding cron).
- Expanded the `GEO_API_KEYS` comment with the per-consumer dedup rationale (the plan asked for the `:cron`/`:ottolax` entries; added one line on *why* they need distinct consumer_ids).

## Deferred / Out of Scope (this plan)

- **Live scheduled firing (DEPLOY-02 live)** — actual Coolify Scheduled-Task registration + first-fire verification is operator action behind the Phase 6 deploy gate. DEFERRED-LIVE; captured in this plan's `user_setup` and the deploy.md callout.
- **CONS-01 / CONS-02 consumer artifacts** (`examples/how-inline-usage.ts`, `examples/ottolax-client.py`, `docs/consumers.md`) — separate Wave-2/3 plan, not this one.

## Threat Flags

None — no new network endpoint, auth path, or schema surface. Edits are additive Docker config + docs. T-07-05 (info disclosure) and T-07-06 (sub-1h cadence tampering) both mitigated by placeholder-only docs and the loud cadence warning.

## Self-Check: PASSED

- Files modified present: Dockerfile, .env.example, docs/deploy.md — all contain the required markers (`packages/cron/package.json`, `CRON_TARGET_URLS`, `Scheduled Task`).
- Commits FOUND: 93a6a30 (Task 1 Dockerfile), 0805f42 (Task 2 env + deploy docs).
