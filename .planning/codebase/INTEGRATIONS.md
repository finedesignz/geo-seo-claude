# External Integrations

**Analysis Date:** 2026-07-24

## APIs & External Services

**LLM scoring (two mutually exclusive providers, selected by `SCORING_PROVIDER`):**
- Anthropic Messages API — scores audit findings.
  - SDK/Client: `@anthropic-ai/sdk` 0.100.1, used in `packages/worker/src/scorer.ts`
  - Auth: `ANTHROPIC_API_KEY`
  - Selected by `SCORING_PROVIDER=api`; also the implicit default when `ANTHROPIC_API_KEY` is present (`packages/worker/src/env.ts:33`)
- Claude Code CLI (subscription billing, no API key) — same scoring job via a spawned process.
  - SDK/Client: `@anthropic-ai/claude-code` installed globally in the image (`Dockerfile:67`); spawned in `packages/worker/src/cli-scorer.ts` as `claude -p <prompt> --output-format stream-json --verbose --model <id>` (`packages/worker/src/cli-scorer.ts:132`)
  - Auth: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or an ambient `claude login` session on a workstation
  - Binary path override: `CLAUDE_BIN` (defaults to `claude` on PATH, `packages/worker/src/cli-scorer.ts:251`)
  - Selected by `SCORING_PROVIDER=cli`; required env is validated at `packages/worker/src/env.ts:54`
  - Critical constraint documented in-code: a present `ANTHROPIC_API_KEY` changes the CLI's billing mode, so the CLI path must run with it absent. Both token names are scrubbed from any logged environment (`packages/worker/src/cli-scorer.ts:178`).
- Model: `SCORING_MODEL`, defaulting to `claude-sonnet-4-6` (`packages/worker/src/main.ts:49`).

**Audited target sites (arbitrary third-party HTTP):**
- Every outbound request to a user-supplied URL goes through the SSRF-hardened `@geo/fetch` layer — `packages/fetch/src/safe-fetcher.ts`, `packages/fetch/src/safe-requester.ts`, `packages/fetch/src/dns-resolve.ts`, `packages/fetch/src/ip-validator.ts`, `packages/fetch/src/decompression.ts`.
  - Client: `undici` 8.3.0 + `ipaddr.js` 2.4.0
  - Guarantees: host re-resolved and IP-classified on every attempt (TOCTOU-safe), redirects disallowed, response-size cap, bounded timeout, limited retries with backoff.
  - No credentials — these are anonymous public fetches.

## Data Storage

**Databases:**
- PostgreSQL (Coolify-hosted)
  - Connection: `DATABASE_URL` (required; validated at `packages/worker/src/env.ts:64`)
  - Client: `postgres` 3.4.9, single pooled client in `packages/db/src/client.ts` (`max: 10`)
  - Access layer: `packages/db/src/dal.ts`; schema in `packages/db/migrations/0001_create_audits.sql` and `0002_add_consumer_id.sql`; runner `packages/db/src/migrate.ts` invoked via `packages/db/scripts/migrate.ts` (advisory-locked, idempotent, run pre-deploy)
- PGlite (`@electric-sql/pglite` 0.5.1) — test-only in-process Postgres, dev dependency, gated by `ALLOW_DB_TESTS`. Pruned out of the runtime image (`Dockerfile:73-75`).

**File Storage:**
- None. The only file written at runtime is the worker liveness heartbeat at `WORKER_HEARTBEAT_FILE`, read back by `scripts/worker-healthcheck.sh`.

**Caching:**
- None. No Redis, memcached, or external cache client in any manifest.

## Authentication & Identity

**Inbound API auth:**
- Custom static bearer tokens — no Titanium Licensing, Auth0, or OAuth provider.
  - Implementation: `packages/api/src/middleware/auth.ts`. `GEO_API_KEYS` is parsed at startup into a token → `consumer_id` map; the process refuses to boot if it is missing or parses empty (`packages/api/src/middleware/auth.ts:48`, `:73`).
  - Every data route requires `Authorization: Bearer <token>` (scheme match case-insensitive); comparison is hashed to fixed length then `crypto.timingSafeEqual` (`packages/api/src/middleware/auth.ts:140`). The header is never logged. `/healthz` is exempt.
  - `consumer_id` derived from the token scopes all audit rows (migration `0002_add_consumer_id.sql`).

**Outbound (cron → API):**
- The cron role calls the API as a normal bearer client using `CRON_API_TOKEN` against `GEO_API_BASE_URL` (`packages/cron/src/env.ts:61-74`).

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry/Datadog/OTel dependency in any package manifest.

**Logs:**
- Structured stdout logging only, consumed by Coolify. Secrets are explicitly redacted before logging (`packages/worker/src/cli-scorer.ts:172-178`); the `Authorization` header is never logged.

**Health:**
- API: HTTP probe against `packages/api/src/routes/healthz.ts`.
- Worker: heartbeat-file freshness via `scripts/worker-healthcheck.sh` (no port to probe).
- Configured per-resource in Coolify; the image deliberately declares no `HEALTHCHECK` (`Dockerfile:90-92`).

## CI/CD & Deployment

**Hosting:**
- Coolify (`coolify.titaniumlabs.us`), Dockerfile build pack. One image, three resources differentiated by `GEO_ROLE` (`api` | `worker` | `cron`) dispatched in `scripts/docker-entrypoint.sh:17-21` — Coolify's Dockerfile build pack does not honor per-resource start-command overrides (`Dockerfile:11-12`).
- Coolify stop grace must be >= the worker's `SHUTDOWN_GRACE_MS` so in-flight audits drain (`Dockerfile:87`).
- Cron runs as a Coolify scheduled task executing the one-shot `cron` role.
- Post-deploy smoke checks: `scripts/deploy-verify.sh`.

**CI Pipeline:**
- None — no `.github/` directory exists. Build, test, and release are run locally or by an agent.

## Environment Configuration

**Required env vars:**
- All roles: `DATABASE_URL`
- API: `GEO_API_KEYS`, `PORT` (default 8080), `GEO_ROLE=api`
- Worker: `GEO_ROLE=worker`, `SCORING_PROVIDER` plus either `ANTHROPIC_API_KEY` (api) or `CLAUDE_CODE_OAUTH_TOKEN` (cli); optional `SCORING_MODEL`, `CLAUDE_BIN`, `WORKER_HEARTBEAT_FILE`, `SHUTDOWN_GRACE_MS`
- Cron: `GEO_ROLE=cron`, `CRON_TARGET_URLS`, `CRON_API_TOKEN`, `GEO_API_BASE_URL`
- Tests: `ALLOW_DB_TESTS`

**Secrets location:**
- Injected via Coolify resource env at runtime; never baked into the image (`Dockerfile:15`) and `.env*` is excluded by `.dockerignore`. `.env.example` in the repo root documents the contract with placeholder values only.

## Webhooks & Callbacks

**Incoming:**
- None. The API exposes only `POST /audits`, `GET /audits/{id}`, `GET /audits`, and `/healthz` (`packages/api/src/routes/audit-post.ts`, `audit-get.ts`, `audits-list.ts`, `healthz.ts`).

**Outgoing:**
- Consumer callback delivery — the worker POSTs the audit outcome (`job_id`, `status`, `score`, `findings`) to a consumer-supplied `callback_url` in `packages/worker/src/webhook.ts`.
  - Fired through the SSRF-safe `createSafeRequester`: host re-resolved and IP-classified per attempt, redirects blocked (3xx → `REDIRECT_BLOCKED`), response-size cap, 5s timeout, 2 retries with backoff.
  - Delivery is non-fatal: every failure is logged and swallowed; `deliverWebhook` never throws and never affects job state.
  - No signing — there is no HMAC/signature header on the outgoing payload.

---

*Integration audit: 2026-07-24*
