---
phase: 3
reviewers: [gemini, codex]
reviewed_at: 2026-06-02
plans_reviewed: [03-00, 03-01, 03-02]
verdict: approved WITH mandatory hardening (lease fencing, advisory-locked migrations, TEST_DATABASE_URL) folded into CONTEXT + execution
---

# Cross-AI Plan Review — Phase 3

## Gemini Review

# Phase 3 Plan Review: Postgres Schema & Durable Job Queue

## Summary
The Phase 3 plans provide a robust and idiomatically correct foundation for the `geo-api` persistence layer. By leveraging `postgres.js` for its stable tagged-template API and implementing a custom, lightweight migration runner, the project avoids unnecessary dependencies while maintaining high security and reliability standards. The centerpiece—a `SKIP LOCKED` job queue—is designed with strict adherence to transaction integrity, ensuring that job claims are atomic and concurrent-safe.

## Strengths
- **Transactional Integrity:** The `claimNextJob` implementation correctly wraps both the `SELECT ... FOR UPDATE SKIP LOCKED` and the `UPDATE` in a single `sql.begin` block. This is the critical invariant for preventing double-claims.
- **Atomic Reclaims:** The `reclaimExpired` logic uses a single atomic `UPDATE` with a `WHERE` clause, effectively eliminating TOCTOU (Time-of-Check to Time-of-Use) races that often plague background worker systems.
- **Smart Testing Strategy:** The use of **PGlite** for unit and integration testing allows for a "real Postgres" experience (SQL syntax, constraints, triggers) without the overhead or environment requirements of Docker.
- **Security Posture:** Structural SQL injection prevention via tagged templates and a fail-fast `DATABASE_URL` guard demonstrate a security-first approach.
- **Database Heuristics:** The use of partial indexes (`status='queued'`) and `CHECK` constraints (rather than native enums) shows a deep understanding of Postgres performance and maintenance trade-offs.

## Concerns
- **Queue Starvation (LOW):** While `ORDER BY created_at` is used for FIFO, there is no "priority" mechanism. For an MVP, this is acceptable, but something to monitor if high-priority audits (e.g., real-time UI requests) are mixed with bulk crons.
- **PGlite Concurrency Limitation (MED):** PGlite is single-connection. While the plan asserts the *structural correctness* of the `SKIP LOCKED` SQL, the behavior cannot be empirically proven until a multi-connection Postgres instance is used. The plan correctly gates this behind `DATABASE_URL`, but it remains a "trust but verify" point for Phase 6.
- **JSONB Payload Growth (LOW):** The `findings` column is `jsonb`. While the research notes size capping at the worker boundary, a rogue worker or malformed data could still lead to large row sizes. Postgres handles this well (TOAST), but it's a downstream concern for Phase 4.

## Suggestions
- **Index on `lease_expires_at`:** Consider adding an index on `(status, lease_expires_at)` to optimize the `reclaimExpired` query as the `audits` table grows, ensuring the background cleanup remains O(1) or O(log N) rather than a sequential scan.
- **Normalized URL Logic:** Ensure the `normalized_url` logic in the DAL matches the one intended for `@geo/core` to prevent "different URLs" from polluting the dedup index due to trailing slashes or case sensitivity.
- **Explicit Type Guards:** In `packages/db/src/types.ts`, consider adding Zod schemas (matching the Hono API layer) to validate the `findings` payload on the way *out* of the DB, ensuring type safety even if the schema evolves.

## Risk Assessment
- **Queue Correctness:** **LOW RISK.** The plan explicitly identifies and mitigates common `SKIP LOCKED` pitfalls (Pitfalls 1, 2, and 3).
- **Migration Safety:** **LOW RISK.** Idempotency is handled via `schema_migrations` and transactions.
- **Deployment/Ops:** **LOW RISK.** Env-based configuration and Coolify-native Postgres usage align with global project standards.
- **Testing Realism:** **MEDIUM RISK.** Transitioning from PGlite (local) to real Postgres (Coolify) is the only significant "leap of faith," mitigated by the structural assertions planned for Wave 2.

**Verdict:** The plans are **APPROVED** for execution. The technical choices are surgical, idiomatic, and highly focused on the core requirements.

---

## Codex Review

**Summary**

The Phase 3 plan is directionally strong, but I would not execute it unchanged. The core SKIP LOCKED claim shape is right, but lease/reclaim safety has a serious stale-worker race, and the “real concurrency” proof is too easy to skip or accidentally run against the wrong database.

**Strengths**

- Correctly avoids Redis/Celery and keeps the durable queue in Postgres.
- Uses the right SKIP LOCKED invariant: `SELECT ... FOR UPDATE SKIP LOCKED` and `UPDATE` inside the same transaction.
- Plain SQL migrations are appropriate for this scope.
- CHECK-constrained text status is a good choice over native enum for early-stage evolution.
- The plan correctly recognizes that PGlite cannot prove true lock concurrency.
- DATABASE_URL is treated as env-only, with no real value committed.

**Concerns**

**HIGH: lease/reclaim is not race-safe.**  
Current `completeJob(id, ...) WHERE id AND status='running'` allows stale worker overwrite:

1. Worker A claims job, lease expires.
2. `reclaimExpired()` flips it back to `queued`.
3. Worker B claims it, status becomes `running`.
4. Worker A finishes late and calls `completeJob(id)`.
5. Because status is `running`, A can mark B’s active attempt as `done`.

Add a fencing token: `lease_token uuid`, `claim_attempt`, or require matching `attempts + locked_at`. Best: `lease_token uuid`, returned by `claimNextJob`, required by `completeJob`, `failJob`, and `renewLease`.

**HIGH: real SKIP LOCKED proof is deferrable.**  
If the real Postgres concurrency test skips whenever `DATABASE_URL` is absent, Phase 3 can “pass” without proving its central invariant. PGlite lifecycle tests are useful, but they do not validate concurrent row locking. Make a real Postgres run a required Phase 3 acceptance gate, even if local runs skip it.

**HIGH: concurrency test should not use production `DATABASE_URL`.**  
A test that migrates and seeds rows against `DATABASE_URL` risks mutating Coolify/prod by accident. Use `TEST_DATABASE_URL` or `GEO_DB_TEST_DATABASE_URL`, require an explicit guard like `ALLOW_DB_TESTS=1`, and reject URLs whose DB name does not look test-only.

**HIGH: migration runner needs an advisory lock.**  
Without `pg_advisory_lock`, two service instances or CI jobs can both observe a pending migration and apply it concurrently. Add a migration-wide advisory lock before reading pending migrations.

**MED: Phase 3 success criterion overstates crash recovery.**  
A `reclaimExpired()` function alone does not prevent jobs from staying `running`; something has to call it. Either make `claimNextJob()` reclaim expired work before claiming, or explicitly require Phase 4 worker startup/poll loop to call it.

**MED: lazy `getSql()` conflicts with “import fails fast.”**  
Lazy factory is better than top-level throw, but update the truth statement. Expose `assertDatabaseUrl()` or make API/worker startup explicitly call `getSql()`/health check.

**MED: DAL signatures are ambiguous.**  
The plan says functions are parameterized on the executor, but the listed public signatures omit it. Prefer a clear shape like `createAuditDal(sql)` returning the 8 methods, with optional default wrappers using `getSql()`.

**MED: migrations may be omitted from package artifacts.**  
`files: ["dist"]` plus migrations under `packages/db/migrations` can break production images if only built package files are copied. Include migrations/scripts in the package or define the container copy contract.

**LOW/MED: indexes need tightening.**  
Use `idx_audits_queued (created_at, id) WHERE status='queued'`, add `idx_audits_running_expired (lease_expires_at) WHERE status='running'`, and consider `(url_hash, created_at DESC)` for dedup.

**Suggestions**

- Add `lease_token uuid null` to `audits`.
- Change `claimNextJob()` to set and return `leaseToken`.
- Change `completeJob` / `failJob` to require `{ id, leaseToken }` and use `RETURNING id`; throw or return false on zero rows.
- Add `renewLease(id, leaseToken, leaseSecs)` now if audits may exceed the lease.
- Clear `lease_token`, `locked_at`, and `lease_expires_at` on terminal states.
- Add migration advisory lock plus optional checksum tracking in `schema_migrations`.
- Replace `DATABASE_URL`-gated tests with `TEST_DATABASE_URL`-gated tests.
- Make real Postgres concurrency a required acceptance step before marking Phase 3 complete.
- Use exact interval SQL, e.g. `now() + (${leaseSecs}::int * interval '1 second')` and `now() - (${ttlMs}::bigint * interval '1 millisecond')`.
- Add deterministic ordering: `ORDER BY created_at, id`.

**Risk Assessment**

Current risk is **medium-high** for queue correctness because stale workers can complete reclaimed jobs. Migration risk is **medium** due to missing advisory locking. Secret handling risk is **low-medium**, mostly wording/test-env hygiene rather than design. Test realism risk is **medium-high** unless real Postgres concurrency becomes a hard gate.

With lease fencing, advisory migration locking, and a protected real-Postgres test path, this becomes a solid Phase 3 plan.

---

## Consensus Summary

Gemini approves (low risk, surgical). Codex rates current plan medium-high risk and surfaces 4 HIGH correctness/safety issues that ARE folded into execution (and into CONTEXT.md D-04/06/08/10 + VALIDATION.md):

### HIGH — mandatory (fold in)
1. **Lease fencing token (real race fix).** Stale worker can complete a job that was reclaimed + re-claimed by another worker. Add `lease_token uuid` to `audits`; `claimNextJob` sets + RETURNS it; `completeJob`/`failJob`/`renewLease` REQUIRE the matching token and use `RETURNING id` (return false / throw on zero rows). Clear `lease_token`/`locked_at`/`lease_expires_at` on terminal states.
2. **Real SKIP LOCKED proof is a REQUIRED acceptance gate**, not silently skippable. When no test DB is present it is DEFERRED to Phase 6 (DEPLOY-04) and tracked as an explicit must-verify — never counted as silently passed.
3. **Concurrency test uses `TEST_DATABASE_URL` (+ `ALLOW_DB_TESTS=1` guard, reject non-test-looking DB names)** — NEVER the prod `DATABASE_URL`, to avoid mutating Coolify/prod.
4. **Migration runner takes a `pg_advisory_lock`** before reading/applying pending migrations (prevents two instances/CI jobs applying concurrently). Optional checksum in `schema_migrations`.

### MED — fold where cheap
- `claimNextJob()` reclaims expired leases before claiming (or Phase 4 worker loop must call `reclaimExpired()`); criterion-3 wording reflects this.
- DAL shape `createAuditDal(sql)` returning the methods (executor/connection explicit); default wrapper uses lazy `getSql()`; expose `assertDatabaseUrl()` for fail-fast at startup.
- Package must ship `migrations/` in published artifacts / container copy contract (not just `dist`).
- Index tightening: `idx_audits_queued (created_at, id) WHERE status='queued'`; `idx_audits_running_expired (lease_expires_at) WHERE status='running'`; dedup `(url_hash, created_at DESC)`.
- Deterministic ordering `ORDER BY created_at, id`; exact interval SQL `now() + (${secs}::int * interval '1 second')`.

### LOW (note)
- No priority queue (FIFO only) — acceptable for MVP.
- jsonb findings growth — capped at Phase 4 worker boundary (TOAST handles storage).
