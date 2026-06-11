# Deploy Runbook — `@geo/api` + `@geo/worker` on Coolify

How to deploy the GEO audit service to Coolify (Postgres on Coolify per global rule 17)
and prove the deploy is live. Authored without a live resource — Phase 6 plan 03 (and
Phase 7) executes against it. **Leave UUIDs/secrets as placeholders; the operator fills them.**

> Legend: **[HUMAN GATE]** = operator does it in the Coolify UI (one-time / credentialed).
> **[AUTOMATABLE]** = doable via the Coolify API with the token in `~/.claude/secrets/services.json`.

---

## Overview — one image, four run targets

Plan 01 ships a single multi-stage `Dockerfile` (`oven/bun:1.3.1-slim`) that builds the
whole Bun workspace. The **role is chosen by the start-command override** — there is no
entrypoint branch script (D-01 / D-03):

| Run target | Start command (override)              | Network    | Health                                   |
|------------|---------------------------------------|------------|------------------------------------------|
| API        | _default CMD_ `bun packages/api/dist/main.js` | HTTP (8080) | `GET /healthz`                           |
| Worker     | `bun packages/worker/dist/main.js`    | none       | exec `scripts/worker-healthcheck.sh` (heartbeat) |
| Migrate    | `bun packages/db/scripts/migrate.ts`  | none       | one-shot (Pre-deployment command, below) |
| Cron       | `bun packages/cron/dist/main.js`      | none       | one-shot (Scheduled Task, below)         |

All four run **the same image / repo / branch** — only the command and resource settings differ.

---

## Human Gate (operator, Coolify UI)

### 1. Provision app + Postgres  **[HUMAN GATE]**

1. New **Project / Application** → Build Pack = **Dockerfile**, source = this repo, branch
   = the deploy branch (e.g. `main`). Dockerfile path = repo-root `Dockerfile`.
2. Add a **PostgreSQL** resource in the same project (one Postgres per app, rule 17).
3. Capture for later: the **API app UUID**, the **worker app UUID**, and Coolify's
   **internal `DATABASE_URL`** for the Postgres resource (use the internal/service hostname,
   not the public proxy).

> Placeholders to record (do NOT commit): `<API_APP_UUID>`, `<WORKER_APP_UUID>`,
> `<DATABASE_URL>`.

### 2. Set env secrets per resource  **[HUMAN GATE]**

Enter in the Coolify UI — **never committed**. Names/defaults come from `.env.example`
(plan 01). Required + relevant per resource:

| Var                    | API | Worker | Migrate | Notes                                              |
|------------------------|:---:|:------:|:-------:|----------------------------------------------------|
| `DATABASE_URL`         |  ✔  |   ✔    |    ✔    | Coolify-internal Postgres URL (secret)             |
| `SCORING_PROVIDER`     |     |   ✔    |         | `api` (default w/ key) or `cli` (Claude subscription) |
| `ANTHROPIC_API_KEY`    |     |  ✔*    |         | scoring key (secret) — required when `SCORING_PROVIDER=api` |
| `CLAUDE_CODE_OAUTH_TOKEN` | |  ✔*    |         | `claude setup-token` output (secret) — required when `SCORING_PROVIDER=cli` |
| `GEO_API_KEYS`         |  ✔  |        |         | bearer allow-list `token:consumer_id,...` (secret) |
| `PORT`                 |  ✔  |        |         | default 8080 (match the resource's HTTP port)      |
| `SHUTDOWN_GRACE_MS`    |     |   ✔    |         | default 30000 — see stop grace (step 4)            |
| `SCORING_MODEL`        |     |   ✔    |         | optional override                                  |
| worker poll knobs      |     |   ✔    |         | `CONCURRENCY`, `POLL_INTERVAL_MS`, `LEASE_TTL_SECONDS`, `RECLAIM_INTERVAL_MS`, `MAX_ATTEMPTS`, `SCORING_TIMEOUT_MS`, `WORKER_HEARTBEAT_FILE` (defaults in `.env.example`) |

The bearer used by `deploy-verify.sh` (`GEO_API_TOKEN`) is the **token part before the `:`**
of one `GEO_API_KEYS` entry.

**Scoring provider — API key vs Claude subscription.** The worker scores either via
the Anthropic Messages API (`SCORING_PROVIDER=api`, needs `ANTHROPIC_API_KEY`) or via the
**Claude Code CLI** against a Claude subscription (`SCORING_PROVIDER=cli`). For `cli`:
1. On a machine logged into the subscription, run `claude setup-token` → copy the long-lived token.
2. Set `CLAUDE_CODE_OAUTH_TOKEN=<token>` in the worker resource env (and `SCORING_PROVIDER=cli`).
3. The runtime image already bundles the `claude` binary (Dockerfile installs `@anthropic-ai/claude-code`).
The worker strips `ANTHROPIC_API_KEY` from the CLI's environment so it always bills the
subscription, never the API. Note: a consumer subscription is intended for interactive use —
prefer an `ANTHROPIC_API_KEY` for production customer audit volume (rate limits + ToS).

### 3. Two Application resources off the same image  **[HUMAN GATE]**

Create **two** Application resources from the same repo/Dockerfile:

- **API resource** — default CMD (no override). Expose HTTP **8080**. Set the
  **HTTP health check** to path `/healthz` (expects 200 `{"db":"ok"}`, public/auth-exempt).
- **Worker resource** — **start command override** `bun packages/worker/dist/main.js`.
  **No HTTP port.** Set health to an **exec** check running `scripts/worker-healthcheck.sh`
  (file-based heartbeat liveness, plan 01). _Confirm in Coolify UI_ (Q2): if a per-resource
  exec health check is unavailable, fall back to **restart-on-exit** — D-06 accepts this,
  since the worker process exits on fatal error.

### 4. Worker stop grace ≥ `SHUTDOWN_GRACE_MS`  **[HUMAN GATE]**

Set the **worker resource container stop grace period ≥ 30s** (≥ `SHUTDOWN_GRACE_MS`,
default 30000). Docker's default 10s is too short and would SIGKILL mid-drain (D-09,
success criterion #4). _Confirm the exact UI field in Coolify_ (Q4). The worker installs
SIGTERM/SIGINT handlers and drains in-flight audits within this window.

---

## Migrations (D-05)

Run the schema migration **before/at first deploy** and on every deploy. The runner is
**advisory-locked + idempotent**, so concurrent/repeat runs are safe:

- **Preferred:** set the **API resource Pre-deployment command** to
  `bun packages/db/scripts/migrate.ts`. Coolify runs it in the freshly-built image before
  cutting traffic over.
- **Fallback:** a guarded boot-time run (first replica acquires the advisory lock; others
  no-op). Use only if Pre-deployment commands are unavailable.

Never run destructive DB ops here — migrate only applies the committed, reviewed SQL in
`packages/db/migrations/**` (retained in the image; see `.dockerignore`).

---

## PID-1 / signal handling (D-09, Q3)

Bun is PID 1 via exec-form CMD and `STOPSIGNAL` is `SIGTERM`. To guarantee zombie reaping
+ clean signal forwarding:

- **Preferred:** enable Coolify's **`--init`** toggle per resource if exposed.
- **Fallback:** uncomment the `tini` `ENTRYPOINT` block in the `Dockerfile` and rebuild.

The worker's SIGTERM/SIGINT handlers + the stop-grace window (step 4) give a clean drain.

---

## Automatable (Coolify API)  **[AUTOMATABLE]**

Trigger a redeploy and poll status with the API token from `~/.claude/secrets/services.json`:

```bash
# UUID from the resource's Coolify URL / step 1 capture.
curl -fsS -X POST \
  -H "Authorization: Bearer <COOLIFY_API_TOKEN>" \
  "https://coolify.titaniumlabs.us/api/v1/deploy?uuid=<API_APP_UUID>"
# repeat with <WORKER_APP_UUID> for the worker resource.
```

Poll the deployment/resource status endpoint until the deploy reports success, then verify.

---

## Verify (D-08, DEPLOY-04, rule 14)

**Never claim "shipped" on `/healthz` alone.** After both resources are up, run the live
smoke test against the deployed API:

```bash
GEO_API_BASE="https://<deployed-api-origin>" \
GEO_API_TOKEN="<token-part-of-a-GEO_API_KEYS-entry>" \
  bash scripts/deploy-verify.sh
```

It polls `/healthz`, probes `/openapi.json` + `/docs`, asserts unauth `POST /audit` → 401,
submits an authed audit, and polls `GET /audit/{job_id}` to `done`. Exit 0 = deploy proven.

---

## Redeploy safety (success criterion #4)

In-flight audits are **not lost across redeploys**: jobs are durable in Postgres (Phase 3/4
queue with lease + reclaim). On SIGTERM the worker drains within `SHUTDOWN_GRACE_MS`; any
job not finished in time keeps its row and is reclaimed by the next worker after its lease
expires. **Requirement:** worker stop grace ≥ `SHUTDOWN_GRACE_MS` (step 4) — otherwise a
SIGKILL mid-audit leaves the job leased until reclaim, adding latency (never data loss).

---

## Cron / scheduled re-audit (DEPLOY-02)

The same image runs a **one-shot** cron caller that POSTs `/audit` to the deployed API for
each configured URL, using a dedicated `cron` consumer bearer. It does NOT self-schedule —
the clock is a **Coolify Scheduled Task**. The cron only ENQUEUES jobs; the worker does the
slow scoring async (Pitfall 4), so a fire can return quickly and overlap between fires is
unlikely. It never fetches the target sites itself (no SSRF surface added — T-07-02).

### 1. Register the Scheduled Task  **[HUMAN GATE]**

On the **API (geo-api) resource** → **Scheduled Tasks** → add a task:

- **Command:** `bun packages/cron/dist/main.js`
- **Frequency:** `0 4 * * *` (default — 04:00 **UTC** daily). This is the `CRON_SCHEDULE`
  value; the process itself ignores it, so the Coolify field is the source of truth.

### 2. Cron env + the `:cron` consumer key  **[HUMAN GATE]**

Set on the geo-api resource (the Scheduled Task inherits the resource env), all **secrets**:

| Var                | Notes                                                                       |
|--------------------|-----------------------------------------------------------------------------|
| `GEO_API_KEYS`     | **Append** a `<cron-token>:cron` entry (dedicated consumer_id, secret)       |
| `CRON_API_TOKEN`   | The token part of that `:cron` entry — bearer the cron sends (secret)        |
| `CRON_TARGET_URLS` | Comma/newline list of http(s) site URLs to re-audit                         |
| `GEO_API_BASE_URL` | Internal origin of the API resource (e.g. `http://geo-api:8080`)            |

Defaults/names come from `.env.example` (CRON block). Placeholders only — operator fills real values.

### 3. ⚠️ Cadence constraint — MUST fire LESS than once per hour

The API dedups submissions **per consumer** within a **hardcoded 1-hour `DEDUP_TTL`
window**, and there is **no force flag** (D-3). A `cron` consumer that fires **more often
than hourly will silently dedup** its own re-audits — the second fire returns the first
fire's job and no new audit runs. Keep `CRON_SCHEDULE` **strictly less frequent than
hourly** (default `0 4 * * *` = daily is safe). This is Pitfall 1 — do not "fix" a
missing re-audit by tightening the schedule.

### 4. Timezone note (Pitfall 2)

Coolify cron expressions evaluate in **UTC**. `0 4 * * *` is 04:00 UTC, not local time.
Pick the hour in UTC deliberately (e.g. off-peak for the target sites' region).

### 5. (DEFERRED-LIVE) verify live firing  **[HUMAN GATE]**

Mirrors Phase 6: **live scheduled firing + jobs-in-history are verified only AFTER the
operator deploy.** Once the task is registered and a deploy is live:

- Trigger the Scheduled Task manually from the Coolify UI (or wait for the first fire).
- Confirm new `cron`-consumer jobs appear via `GET /audit/{job_id}` (use the smoke flow in
  `scripts/deploy-verify.sh` as the auth/endpoint reference; `/openapi.json` is the contract
  source of truth).
- A second manual fire **within the same hour** should dedup (return the same job) — this is
  the cadence constraint working as designed, not a bug.

---

## Open questions to confirm in Coolify UI

| Q  | Confirm |
|----|---------|
| Q2 | per-resource **exec** health check for the worker (else restart-on-exit fallback) |
| Q3 | `--init` toggle exposure (else tini ENTRYPOINT fallback) |
| Q4 | exact **container stop grace** field name/location for the worker resource |
