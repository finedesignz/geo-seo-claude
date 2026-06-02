# Phase 3: Postgres Schema & Durable Job Queue - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver durable storage + a correct job queue: a versioned, migration-managed Postgres schema for audit jobs/results, and a `SELECT … FOR UPDATE SKIP LOCKED` claim mechanism with lease/timeout recovery — all in a shared `@geo/db` package consumed by the Phase 4 worker and Phase 5 API. Must survive service restarts.

Covers DATA-01, DATA-02, DATA-03, DATA-04, WORK-01. Does NOT include: the worker pipeline / scoring (Phase 4, which uses this queue), the HTTP API (Phase 5), or actual Coolify provisioning/deploy (Phase 6). WORK-04 (crashed-job recovery) is Phase 4, but this phase provides the lease columns + a `reclaim_expired` query it builds on.
</domain>

<decisions>
## Implementation Decisions

### Package & driver
- **D-01:** Lives as a shared workspace package `packages/db/` (`@geo/db`) — a typed data-access layer (DAL) + migration runner — consumed by the Phase 4 worker and Phase 5 API. (recommended)
- **D-02:** Postgres client = `postgres` (porsager/postgres.js) — lightweight, Bun-friendly, parameterized by default. NOT a heavy ORM. (per global rule 17; recommended)
- **D-03:** `DATABASE_URL` read from env ONLY, never committed (DATA-03). Provide `.env.example` with a placeholder; real value lives in Coolify env (Phase 6). A startup check fails fast if `DATABASE_URL` is missing. (recommended)

### Migrations (DATA-04)
- **D-04:** Plain versioned SQL migrations in `packages/db/migrations/NNNN_<name>.sql`, applied by a tiny idempotent runner that records applied versions in a `schema_migrations` table and runs each pending file in a transaction. Repeatable on a fresh DB. No heavyweight migration framework. **The runner takes a `pg_advisory_lock` before reading/applying pending migrations** (prevents two instances/CI jobs applying concurrently — cross-AI review). Migrations directory MUST ship in published artifacts / container copy (not just `dist/`). (recommended)
- **D-05:** A `bun run --cwd packages/db migrate` script applies pending migrations; `migrate:status` lists them. (recommended)

### Schema (DATA-01/02)
- **D-06:** `audits` table: `id uuid pk default gen_random_uuid()`, `url text`, `normalized_url text`, `url_hash text` (for dedup lookups, Phase 5 API-04), `status` (enum/text-check: `queued|running|done|failed`), `score int null` (0–100), `findings jsonb null`, `error_code text null`, `callback_url text null`, `attempts int default 0`, `lease_token uuid null` (**fencing token** — see D-10), `locked_at timestamptz null`, `lease_expires_at timestamptz null`, `created_at timestamptz default now()`, `updated_at timestamptz default now()`, `started_at timestamptz null`, `finished_at timestamptz null`. (recommended; `lease_token` added per cross-AI review to prevent stale-worker completion races)
- **D-07:** Status modeled as a CHECK-constrained text column (not a native enum) for easy additive evolution; an `updated_at` trigger keeps the timestamp fresh. Indexes: partial index on `(created_at)` WHERE `status='queued'` (the claim query's `ORDER BY created_at` benefits — status is already pinned by the WHERE clause), index on `url_hash` for dedup. (recommended)

### Queue (WORK-01 + DATA-02)
- **D-08:** Claim (inside one `sql.begin()`): first `reclaimExpired()` so expired leases are reclaimable, then `SELECT … FROM audits WHERE status='queued' ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`, then in the SAME transaction set `status='running', lease_token=gen_random_uuid(), locked_at=now(), lease_expires_at=now()+(${secs}::int * interval '1 second'), started_at=now(), attempts=attempts+1` and RETURN the row incl. `lease_token`. No Redis/Celery broker. (WORK-01)
- **D-09:** Durable state machine `queued → running → done|failed`, persisted in Postgres so it survives a redeploy (DATA-02). A `reclaimExpired()` query flips `running` rows whose `lease_expires_at < now()` back to `queued` (bounded by a max-attempts guard → `failed`, clearing `lease_token`/`locked_at`/`lease_expires_at`) so a killed worker never strands a job (success criterion 3; full recovery loop wired in Phase 4 WORK-04). (recommended)
- **D-10:** DAL shape `createAuditDal(sql)` returning typed functions (executor/connection explicit; a default wrapper uses lazy `getSql()` + `assertDatabaseUrl()` for fail-fast startup): `insertJob`, `claimNextJob` (returns row incl. `leaseToken`), `completeJob({id, leaseToken, score, findings})`, `failJob({id, leaseToken, errorCode})`, `renewLease(id, leaseToken, secs)`, `getJob(id)`, `listJobs(pagination)`, `findRecentByUrlHash(hash, ttl)` (dedup, Phase 5), `reclaimExpired()`. **`completeJob`/`failJob`/`renewLease` REQUIRE the matching `lease_token` (WHERE id AND lease_token=$tok AND status='running'), use `RETURNING id`, and return false / throw on zero rows** — fencing against stale workers (cross-AI review). Terminal states clear `lease_token`/`locked_at`/`lease_expires_at`. Status/findings types reuse @geo/core result types. (recommended)

### Testing
- **D-11:** Vitest integration tests against a REAL ephemeral Postgres (Testcontainers-postgres, or a `DATABASE_URL`-pointed disposable DB). Test: fresh-migrate produces all columns; SKIP LOCKED gives two concurrent claimers DIFFERENT rows (no double-claim); a `running` row past its lease is reclaimed; full lifecycle queued→running→done/failed. If Docker/Testcontainers is unavailable in the env, gate those tests behind a `DATABASE_URL` env and document it — never mock the SKIP LOCKED semantics (that would prove nothing). (recommended)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project / requirements
- `.planning/REQUIREMENTS.md` §Persistence (DATA-01..04) + §Worker/Job Runner (WORK-01)
- `.planning/ROADMAP.md` — Phase 3 goal + success criteria
- `.planning/PROJECT.md` — Coolify Postgres decision (replaces racy ~/.geo-prospects JSON)

### Stack rules
- Global rule 17 (Postgres on Coolify; `postgres`/`pg`/`drizzle`/`kysely`; never Supabase/SQLite-for-prod) — informs D-02
- `.planning/codebase/CONCERNS.md` — racy JSON read-modify-write this phase replaces

### Downstream consumers (contracts to anticipate)
- Phase 4 worker: claims jobs via D-08, runs @geo/core + scoring, calls completeJob/failJob; WORK-04 builds on reclaimExpired()
- Phase 5 API: insertJob on POST /audit, getJob/listJobs on reads, findRecentByUrlHash for dedup (API-04)

### External
- Postgres SKIP LOCKED docs + "What is SKIP LOCKED for" (correct queue semantics)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@geo/core` result types (findings, citability) — `findings jsonb` shape can reference them; score is the 0–100 from Phase 4.

### Established Patterns
- Workspace package layout (packages/core, packages/fetch) — packages/db follows the same tsup/vitest conventions.
- Structured-result / typed-contract discipline from prior phases.

### Integration Points
- Phase 4 worker + Phase 5 API both import `@geo/db`.
- Coolify provides DATABASE_URL at deploy (Phase 6).

</code_context>

<specifics>
## Specific Ideas

SKIP LOCKED correctness is the heart of this phase — the integration test MUST prove two concurrent claimers get different rows against a real Postgres, never a mock. Lease/timeout columns here are what let Phase 4 guarantee no job is stranded `running` after a crash.
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Full crashed-job recovery loop → Phase 4 WORK-04; dedup TTL endpoint → Phase 5 API-04; idempotency keys → v2 OPS-02.)
</deferred>

---

*Phase: 3-Postgres Schema & Durable Job Queue*
*Context gathered: 2026-06-02*
