# DEPLOY-RECORD — Phase 6 Plan 03 (Live Coolify Deploy)

**STATUS: DEFERRED-LIVE**

The live Coolify deploy was **not performed**. The human gate (operator provisioning of
Coolify resources + secrets) is **UNMET**. Per `06-03-PLAN.md` checkpoint option
`gate-deferred`, this record captures readiness + the exact operator hand-off so the phase
is **not blocked**. The live deploy becomes a **Phase-7 precondition**.

No smoke transcript is fabricated. No secrets or invented UUIDs appear here — placeholders only.

---

## Why deferred (orchestrator-verified preconditions)

1. **No Coolify app/Postgres exists for `geo-api`.** Coolify API creds exist
   (`~/.claude/secrets/services.json`), but nothing is provisioned — there is no app UUID
   to deploy and no Postgres to migrate against.
2. **Branch not pushed / not authorized.** Current branch
   `phase-01-geo-core-deterministic-package` has no upstream. `origin` =
   `https://github.com/zubair-trabzada/geo-seo-claude.git` (third-party account) — pushing
   requires explicit operator authorization (global rule 8/19; not auto-performed).
3. **Secrets not entered.** `DATABASE_URL` (from a Coolify Postgres), `ANTHROPIC_API_KEY`,
   and `GEO_API_KEYS` are not present in any Coolify env.
4. **Operator/human gate.** Standing up new production cloud infra + wiring a live Anthropic
   key is an irreversible/credentialed action (global rule 9). It is operator-owned; there
   is no API path to provision the app/Postgres or to enter Coolify-UI secrets.

---

## READINESS — all build/deploy artifacts complete + locally validated

| Artifact | Path | State |
|----------|------|-------|
| Multi-stage Dockerfile (one image, role by start-cmd) | `Dockerfile` | Complete, statically verified |
| Secret-free build context | `.dockerignore` | Complete (excludes `.env*`, keeps `.env.example` + `packages/db/migrations/**`) |
| 12-factor env template (13 named vars, no values) | `.env.example` | Complete |
| Worker liveness heartbeat + exec health probe | `scripts/worker-healthcheck.sh` (+ `packages/worker/src/worker.ts` heartbeat) | Complete, `bash -n` OK |
| Env-driven live smoke test | `scripts/deploy-verify.sh` | Complete, `bash -n` OK |
| Operator runbook | `docs/deploy.md` | Complete |

**Image is build-ready.** `docker build` was **not** run — no local Docker in this
environment (06-01 deferred issue). The **first image build happens on Coolify** at deploy
time. Base tag `oven/bun:1.3.1-slim` not pull-verified in-env — confirm it resolves on first
Coolify build (fall back to highest stable `1.3.x-slim` if gone).

---

## REMAINING OPERATOR ACTIONS (ordered — condensed from `docs/deploy.md`)

> Full detail incl. [HUMAN GATE] vs [AUTOMATABLE] split lives in `docs/deploy.md`.

1. **Authorize + push the deploy branch** (or merge to `main`) so Coolify can pull the
   source. `origin` is a third-party account — operator must authorize the push.
2. **Create the Coolify app** — Build Pack = **Dockerfile**, source = this repo, branch =
   the deploy branch, Dockerfile path = repo-root `Dockerfile`. Capture `<API_APP_UUID>`,
   `<WORKER_APP_UUID>`.
3. **Add a PostgreSQL resource** in the same project (one Postgres per app, rule 17).
   Capture the Coolify-internal `<DATABASE_URL>`.
4. **Enter env secrets per resource** (Coolify UI, never committed). Required keys
   (values operator-supplied):
   - `DATABASE_URL` — API + Worker + Migrate (Coolify-internal URL)
   - `ANTHROPIC_API_KEY` — Worker only (scoring model key)
   - `GEO_API_KEYS` — API only (bearer allow-list `token:consumer_id,...`)
   - `PORT` — API (default 8080, match resource HTTP port)
   - `SHUTDOWN_GRACE_MS` — Worker (default 30000)
   - optional worker tunables (`CONCURRENCY`, `POLL_INTERVAL_MS`, `LEASE_TTL_SECONDS`,
     `RECLAIM_INTERVAL_MS`, `MAX_ATTEMPTS`, `SCORING_TIMEOUT_MS`, `SCORING_MODEL`,
     `WORKER_HEARTBEAT_FILE`) — defaults in `.env.example`.
5. **Run the one-shot migration** — set the **API resource Pre-deployment command** to
   `bun packages/db/scripts/migrate.ts` (advisory-locked + idempotent; boot-time fallback if
   Pre-deployment commands unavailable).
6. **Wire two resources off one image:**
   - **API** — default CMD (`bun packages/api/dist/main.js`), expose HTTP **8080**, HTTP
     health check path `/healthz` (200 `{"db":"ok"}`, auth-exempt).
   - **Worker** — start-command override `bun packages/worker/dist/main.js`, **no HTTP
     port**, exec health `scripts/worker-healthcheck.sh` (heartbeat liveness; restart-on-exit
     fallback). Set **container stop grace ≥ `SHUTDOWN_GRACE_MS`** (≥ 30s) so redeploy drains
     without job loss.
7. **Trigger the deploy** (automatable):
   `POST https://coolify.titaniumlabs.us/api/v1/deploy?uuid=<APP_UUID>` (token from
   `~/.claude/secrets/services.json`); repeat for the worker UUID. Poll until success.
8. **Run the live smoke:**
   `GEO_API_BASE=<https://deployed-api-origin> GEO_API_TOKEN=<token-part-of-a-GEO_API_KEYS-entry> AUDIT_URL=https://example.com bash scripts/deploy-verify.sh`
   (exit 0 = healthz 200 → docs/openapi 200 → unauth POST 401 → authed audit round-trip to
   `done` with numeric score + findings).

---

## DEFERRED VERIFICATIONS unblocked by the future deploy

Running `scripts/deploy-verify.sh` against the live URL (operator step 8) discharges:

- **Phase 5 deferred-live items:**
  - live `GET /healthz` against a real Coolify Postgres (deep `SELECT 1` `db:ok`)
  - real `POST /audit` → poll `GET /audit/{id}` → `done` round-trip (numeric score +
    findings) end-to-end
  - real webhook (`callback_url`) delivery from a live worker
- **Phase 6 `DEPLOY-04`:** live acceptance smoke (healthz 200, docs reachable, unauth
  POST = 401, authed audit round-trip) — ROADMAP success criteria #2 and #4 (worker stop
  grace ≥ `SHUTDOWN_GRACE_MS`, no job loss on redeploy).

---

## Threat-model note (T-06-08)

No deploy logs were captured (no deploy performed) — there is no transcript to scrub. When
the operator runs the live deploy, confirm no secret value is echoed before committing any
transcript into this record (`env.ts` names vars, never echoes values).
