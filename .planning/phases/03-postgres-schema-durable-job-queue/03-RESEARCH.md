# Phase 3: Postgres Schema & Durable Job Queue — Research

**Researched:** 2026-06-02
**Domain:** Postgres on Bun — SKIP LOCKED job queue, migration runner, typed DAL
**Confidence:** HIGH (stack + patterns), MEDIUM (Bun.sql stability note), HIGH (SKIP LOCKED semantics)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `packages/db/` as `@geo/db` workspace package — typed DAL + migration runner
- **D-02:** Postgres client = `postgres` (porsager/postgres.js v3.4.9) — NOT Bun.sql, NOT heavy ORM
- **D-03:** `DATABASE_URL` from env only; startup check fails fast if missing; `.env.example` with placeholder
- **D-04:** Plain versioned SQL files `packages/db/migrations/NNNN_<name>.sql`; tiny idempotent runner; `schema_migrations` table; each file in a transaction
- **D-05:** `bun run --cwd packages/db migrate` + `migrate:status`
- **D-06:** `audits` table columns (full spec — see Schema section)
- **D-07:** Status = CHECK-constrained text; `updated_at` trigger; partial index on `status='queued'`; index on `url_hash`
- **D-08:** Claim = `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` then update same txn
- **D-09:** `queued → running → done|failed`; `reclaimExpired()` flips expired `running`→`queued` with max-attempts guard
- **D-10:** DAL functions: `insertJob`, `claimNextJob`, `completeJob`, `failJob`, `getJob`, `listJobs`, `findRecentByUrlHash`, `reclaimExpired`
- **D-11:** Integration tests against real ephemeral Postgres; prove two concurrent claimers get different rows; if Docker unavailable gate behind `DATABASE_URL` env

### Claude's Discretion
None recorded — all decisions locked.

### Deferred Ideas (OUT OF SCOPE)
- Full crashed-job recovery loop → Phase 4 WORK-04
- Dedup TTL endpoint → Phase 5 API-04
- Idempotency keys → v2 OPS-02
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DATA-01 | Audit jobs + results in Coolify Postgres (id, url, status, score, findings, timestamps) | Schema design in D-06; postgres.js DAL |
| DATA-02 | Durable job state machine `queued→running→done\|failed` survives redeploy | D-09 SKIP LOCKED pattern; Postgres-backed state |
| DATA-03 | `DATABASE_URL` from Coolify env, never committed | D-03; `.env.example`; startup guard |
| DATA-04 | Migration-managed schema (versioned, repeatable) | D-04 plain SQL runner with `schema_migrations` |
| WORK-01 | Worker claims jobs via `SELECT … FOR UPDATE SKIP LOCKED` | D-08 exact txn shape |
</phase_requirements>

---

## Summary

Phase 3 delivers the persistence foundation: a Postgres schema for audit jobs, a correct durable SKIP LOCKED claim mechanism, lease columns for crash recovery, and a migration runner — all as `@geo/db` consumed by Phases 4 and 5.

The decision to use `postgres` (porsager/postgres.js) v3.4.9 over Bun's built-in `Bun.sql` is correct and important. `Bun.sql` (added in Bun 1.2) has open bugs in June 2026: connection leaks under pool churn (issue #23215), transaction callbacks hanging on constraint violations (issue #21934), and `idleTimeout`/`maxLifetime` killing in-flight queries (issue #30646). `postgres.js` is stable, Bun-compatible, and uses tagged-template parameterization that makes SQL injection structurally impossible.

The SKIP LOCKED pattern is well-established in Postgres 9.5+: one `sql.begin()` block atomically selects and updates, with no gap between claim and status flip. The critical correctness invariant is that the `UPDATE` happens INSIDE the same transaction as the `SELECT FOR UPDATE` — any approach that commits the SELECT separately then updates is broken. Docker is not installed on the dev machine, so Testcontainers is not viable locally; tests must be gated behind `DATABASE_URL` pointing to a real Postgres (Coolify-provisioned or a local `pg` process).

**Primary recommendation:** Use `postgres` v3.4.9 with `sql.begin()` for all transactional operations. Implement a 40-line migration runner (no external framework). Gate integration tests behind `DATABASE_URL` env var; skip with a clear message if absent.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Job persistence + state | Database (Postgres) | — | Source of truth; survives process restart |
| Job claim (SKIP LOCKED) | Database (Postgres) | `@geo/db` DAL | Lock held at DB level; DAL is thin wrapper |
| Migration execution | `@geo/db` runner script | Postgres `schema_migrations` table | Idempotency tracked in DB |
| Typed data-access | `@geo/db` package | — | Consumed by Phase 4 worker + Phase 5 API |
| Lease/timeout tracking | Database columns (`lease_expires_at`) | Phase 4 reclaim loop | Columns defined here; reclaim wired Phase 4 |
| `DATABASE_URL` config | Coolify env → `@geo/db` startup check | `.env.example` | Never in code |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `postgres` | 3.4.9 [VERIFIED: npm registry] | Postgres client | Fastest full-featured; Bun-compatible; tagged-template parameterization; `sql.begin()` transaction API |
| `typescript` | 6.0.3 | Types | Matches workspace convention |
| `tsup` | 8.5.1 | Build | Matches `@geo/core` + `@geo/fetch` pattern |
| `vitest` | 4.1.8 | Test runner | Matches workspace convention |

### Supporting (dev/test only)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `testcontainers` | 12.0.1 [VERIFIED: npm registry] | Ephemeral Postgres in CI | Only when Docker is available; gate behind env check |
| `@testcontainers/postgresql` | 12.0.1 [VERIFIED: npm registry] | PostgreSQL container module | Paired with `testcontainers` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `postgres` (porsager) | `Bun.sql` (built-in) | `Bun.sql` has active production bugs in Bun 1.3.x (connection leak, txn hang); `postgres.js` is stable [ASSUMED: bug status as of Bun 1.3.14 — verify if upgrading Bun] |
| `postgres` (porsager) | `pg` (node-postgres) | `pg` is stable but heavier callback-based API; `postgres.js` is cleaner for tagged-template SQL |
| Plain SQL runner | `node-pg-migrate` / `drizzle-kit` | For 1–3 migration files, a 40-line runner is simpler and has zero new dependencies |

**Installation:**
```bash
# Runtime dep
bun add postgres

# Dev/test deps (integration test only)
bun add -d testcontainers @testcontainers/postgresql
```

---

## Package Legitimacy Audit

| Package | Registry | Age | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|
| `postgres` | npm | ~11 yrs (2015) | [OK] | Approved |
| `testcontainers` | npm | established | [OK] | Approved (dev only) |
| `@testcontainers/postgresql` | npm | established | N/A (scoped, not checked separately) | Approved (dev only) — same org as testcontainers |

**Packages removed due to [SLOP]:** none
**Packages flagged [SUS]:** none

*slopcheck v0.6.1 ran and returned OK for `postgres` and `testcontainers`. `@testcontainers/postgresql` is the official scoped module from the same `testcontainers` organization.*

---

## Architecture Patterns

### System Architecture Diagram

```
ENV: DATABASE_URL
       │
       ▼
 @geo/db startup check ──► crash if missing
       │
       ▼
 postgres.js connection pool (sql)
       │
       ├──► Migration runner
       │       └── schema_migrations table
       │           └── NNNN_*.sql files applied in order, each in a txn
       │
       ├──► DAL functions
       │       ├── insertJob(url, callbackUrl?) → AuditJob
       │       ├── claimNextJob() → AuditJob | null  ← SKIP LOCKED txn
       │       ├── completeJob(id, score, findings)
       │       ├── failJob(id, errorCode)
       │       ├── getJob(id)
       │       ├── listJobs(pagination)
       │       ├── findRecentByUrlHash(hash, ttlMs)
       │       └── reclaimExpired(maxAttempts)
       │
       └──► Postgres (Coolify)
               └── audits table
                   ├── status: 'queued' | 'running' | 'done' | 'failed'
                   ├── lease_expires_at (null when not running)
                   └── partial index WHERE status='queued'
```

### Recommended Project Structure

```
packages/db/
├── src/
│   ├── index.ts          # re-exports DAL + types
│   ├── client.ts         # postgres.js sql instance + DATABASE_URL guard
│   ├── dal.ts            # all DAL functions
│   ├── types.ts          # AuditJob, AuditStatus, FindingsShape
│   └── migrate.ts        # migration runner (40 lines)
├── migrations/
│   ├── 0001_create_audits.sql
│   └── 0002_add_indexes.sql  (or fold into 0001)
├── scripts/
│   └── migrate.ts        # bun run entry: apply + status
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

### Pattern 1: Connection Setup with DATABASE_URL Guard

```typescript
// Source: postgres.js README (porsager/postgres) + D-03 decision
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('@geo/db: DATABASE_URL is required but not set');
}

export const sql = postgres(url, {
  max: 10,           // pool size
  idle_timeout: 20,  // seconds
  connect_timeout: 10,
});
```

**[VERIFIED: npm registry / github.com/porsager/postgres]** — postgres.js accepts a connection string as first arg; all options are second arg.

### Pattern 2: Correct SKIP LOCKED Claim Transaction

The critical invariant: SELECT and UPDATE must be in the SAME transaction. The row lock acquired by `FOR UPDATE` is released at commit — if you commit between SELECT and UPDATE, another worker can claim the same row.

```typescript
// Source: Postgres SKIP LOCKED docs + postgres.js sql.begin() API
export async function claimNextJob(leaseSecs = 300): Promise<AuditJob | null> {
  return sql.begin(async (tx) => {
    // Single statement: lock + skip-locked. ORDER BY created_at ensures FIFO.
    const [row] = await tx`
      SELECT * FROM audits
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!row) return null;

    // Update INSIDE the same transaction — lock held until COMMIT
    const [updated] = await tx`
      UPDATE audits SET
        status = 'running',
        locked_at = now(),
        lease_expires_at = now() + (${leaseSecs} * interval '1 second'),
        started_at = now(),
        attempts = attempts + 1,
        updated_at = now()
      WHERE id = ${row.id}
      RETURNING *
    `;
    return updated as AuditJob;
  });
}
```

**[CITED: PostgreSQL docs FOR UPDATE SKIP LOCKED; postgres.js sql.begin()]** — `sql.begin(callback)` runs the callback in a transaction; any exception rolls back automatically; the connection is reserved for the transaction duration.

### Pattern 3: Lease Reclaim (race-safe)

```typescript
// Source: derived from D-09 + standard Postgres patterns
export async function reclaimExpired(maxAttempts = 3): Promise<number> {
  // Single UPDATE — no SELECT needed, no TOCTOU race
  const result = await sql`
    UPDATE audits SET
      status = CASE
        WHEN attempts >= ${maxAttempts} THEN 'failed'::text
        ELSE 'queued'::text
      END,
      lease_expires_at = NULL,
      locked_at = NULL,
      error_code = CASE
        WHEN attempts >= ${maxAttempts} THEN 'max_attempts_exceeded'
        ELSE NULL
      END,
      updated_at = now()
    WHERE status = 'running'
      AND lease_expires_at < now()
    RETURNING id
  `;
  return result.length;
}
```

**Why no SELECT first:** A `SELECT … WHERE status='running' AND lease_expires_at < now()` followed by an `UPDATE` is a TOCTOU race — another reclaimer or worker can flip the row between the two statements. A single `UPDATE … WHERE … RETURNING` is atomic at the row level. [CITED: standard Postgres UPDATE WHERE pattern]

### Pattern 4: Migration Runner

```typescript
// Source: D-04 decision + standard schema_migrations pattern
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runMigrations(migrationsDir: string): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz DEFAULT now()
    )
  `;

  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace('.sql', '');
    const [existing] = await sql`
      SELECT version FROM schema_migrations WHERE version = ${version}
    `;
    if (existing) continue;

    const sqlText = await readFile(join(migrationsDir, file), 'utf8');
    await sql.begin(async (tx) => {
      // Execute migration SQL (not parameterized — it's a file we own)
      await tx.unsafe(sqlText);
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
    });
    console.log(`Applied migration: ${version}`);
  }
}
```

**Note on `tx.unsafe()`:** postgres.js requires `.unsafe()` to execute raw SQL strings (as opposed to tagged templates). This is correct for migration files we own. Never use `.unsafe()` with user-supplied input. [VERIFIED: npm registry / postgres.js README]

### Pattern 5: updated_at Trigger

```sql
-- Source: standard Postgres trigger pattern
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audits_updated_at
BEFORE UPDATE ON audits
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

This ensures `updated_at` is always current without requiring the DAL to set it explicitly (though explicitly setting it in queries is also fine as belt-and-suspenders).

### Anti-Patterns to Avoid

- **Two-statement claim (SELECT then UPDATE in separate txns):** Classic race condition — two workers both SELECT the same `queued` row before either UPDATE completes. SKIP LOCKED only prevents duplicate claims when SELECT + UPDATE are in the same transaction.
- **Advisory locks as a queue:** `pg_try_advisory_lock` works but ties lock namespace to integer keys, not row state; harder to reason about and doesn't compose with row state transitions.
- **Postgres ENUM for status:** Requires `ALTER TYPE` to add values, which takes a lock and cannot be rolled back in a transaction. CHECK-constrained text evolves with a simple `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT`. [CITED: Postgres ALTER TYPE limitation]
- **`Bun.sql` for this phase:** Active production bugs in Bun 1.3.x — connection leaks (#23215), transaction hang on constraint violation (#21934). Stick with `postgres.js` per D-02. [ASSUMED: status as of Bun 1.3.14 — verify on Bun upgrade]
- **`tx.unsafe()` with user input:** Only use `.unsafe()` for migration files. All DAL queries use tagged templates.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL injection prevention | Manual escaping / string concat | postgres.js tagged templates | Parameterization is structural — impossible to forget |
| Connection pooling | Manual connection lifecycle | postgres.js built-in pool (`max` option) | Pool reuse, error recovery, idle timeout all handled |
| Transaction rollback on error | try/catch + manual ROLLBACK | `sql.begin(callback)` auto-rollback | Any thrown exception triggers automatic ROLLBACK |
| Concurrent job deduplication | Redis lock / application-level mutex | SKIP LOCKED at DB level | Lock lives in Postgres — no external service, survives restarts |
| Migration idempotency | Manual file tracking | `schema_migrations` table | Standard pattern; survives re-runs, fresh DBs, CI |

---

## Schema Definition

Full `0001_create_audits.sql`:

```sql
-- Source: D-06 + D-07 locked decisions

CREATE TABLE audits (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  url              text        NOT NULL,
  normalized_url   text        NOT NULL,
  url_hash         text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued'
                               CONSTRAINT audits_status_check
                               CHECK (status IN ('queued','running','done','failed')),
  score            int         CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  findings         jsonb,
  error_code       text,
  callback_url     text,
  attempts         int         NOT NULL DEFAULT 0,
  locked_at        timestamptz,
  lease_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audits_updated_at
  BEFORE UPDATE ON audits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Queue claim index: only queued rows
CREATE INDEX idx_audits_queued ON audits (created_at)
  WHERE status = 'queued';

-- Dedup lookup
CREATE INDEX idx_audits_url_hash ON audits (url_hash);
```

**Notes:**
- `gen_random_uuid()` is built-in since Postgres 13 (no `pgcrypto` extension needed). [CITED: Postgres 13 release notes]
- `jsonb` for findings: supports GIN indexing if needed later, efficient storage
- Partial index `WHERE status = 'queued'` is small and fast — only rows the claim query cares about
- Score `CHECK` allows NULL (not yet scored) and enforces 0–100 range

---

## Common Pitfalls

### Pitfall 1: Claiming Outside a Transaction
**What goes wrong:** SELECT FOR UPDATE SKIP LOCKED in one statement, UPDATE in a separate SQL call — two workers both see the same row in the gap.
**Why it happens:** Misunderstanding that the lock is released at statement end if no transaction wraps both.
**How to avoid:** Always use `sql.begin()` wrapping both the SELECT and UPDATE.
**Warning signs:** Duplicate `attempts` increments on the same job; tests show same `id` returned to two concurrent claimers.

### Pitfall 2: ORDER BY missing from SKIP LOCKED claim
**What goes wrong:** Without `ORDER BY created_at`, Postgres returns an arbitrary row — typically the first physical row it finds. Under load this becomes non-FIFO and can cause starvation of older jobs.
**How to avoid:** Always `ORDER BY created_at` (or `created_at, id` for determinism) before `FOR UPDATE SKIP LOCKED`.
**Warning signs:** Older jobs not being processed while newer ones run.

### Pitfall 3: TOCTOU in `reclaimExpired`
**What goes wrong:** SELECT expired rows, iterate, UPDATE each — a worker can pick up and complete a job between your SELECT and UPDATE, causing `status` to be flipped from `done` back to `queued`.
**How to avoid:** Single `UPDATE … WHERE status='running' AND lease_expires_at < now()` — atomic at the row level.
**Warning signs:** Jobs showing up as `queued` after being `done`; `attempts` count inflating unexpectedly.

### Pitfall 4: Testcontainers on Bun/Windows (Docker absent)
**What goes wrong:** `@testcontainers/postgresql` fails with a network pipe error on Bun (GitHub issue #1115 testcontainers-node, issue #21342 bun). Docker is also not installed on this machine.
**How to avoid:** Gate tests with `if (!process.env.DATABASE_URL) { it.skip(...) }`. Provide a `README.test.md` explaining how to spin up `docker run -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16` or point `DATABASE_URL` at Coolify dev DB.
**Warning signs:** Tests hang or throw "pipe not found" / "Cannot connect to the Docker daemon".

### Pitfall 5: `tx.unsafe()` scope creep
**What goes wrong:** Developer sees `.unsafe()` used in migrations and starts using it for DAL queries with user input.
**How to avoid:** Comment the migration runner clearly: "`.unsafe()` is ONLY for migration files we control. Never use it with runtime input." All DAL queries use tagged templates.

### Pitfall 6: Connection pool exhaustion during concurrent test workers
**What goes wrong:** Vitest runs test files in parallel workers; each imports the `sql` singleton and opens connections — can exhaust Postgres `max_connections`.
**How to avoid:** Set `max: 5` in test environment; use `--pool=forks` in vitest config (not `--threads`) for integration tests; or use a single serial test file for DB integration tests.

---

## Runtime State Inventory

> Not a rename/refactor phase — this section is N/A.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | All scripts | ✓ | 1.3.14 | — |
| Docker | Testcontainers integration tests | ✗ | — | Gate tests behind `DATABASE_URL` env var pointing to real Postgres |
| Postgres | Integration tests | ✗ locally | — | Use Coolify dev DB; set `DATABASE_URL` |

**Missing dependencies with no fallback:**
- None that block implementation. Tests require `DATABASE_URL` but the test runner skips gracefully if absent.

**Missing dependencies with fallback:**
- Docker: Testcontainers cannot run locally. Tests must use an external Postgres pointed to by `DATABASE_URL`. This is the documented path (D-11).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 |
| Config file | `packages/db/vitest.config.ts` (Wave 0 gap — create) |
| Quick run command | `bun run test --cwd packages/db` |
| Full suite command | `bun run test --cwd packages/db --run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-01 | `runMigrations()` creates all `audits` columns | integration | `vitest run src/dal.test.ts` | ❌ Wave 0 |
| DATA-01 | `insertJob` persists a row; `getJob` retrieves it | integration | same | ❌ Wave 0 |
| DATA-02 | `claimNextJob` returns `null` after all jobs are `running`/`done` | integration | same | ❌ Wave 0 |
| DATA-02 | Two concurrent `claimNextJob` calls return DIFFERENT row IDs | integration (concurrency) | same | ❌ Wave 0 |
| DATA-02 | `completeJob` sets `status='done'`, `score`, `findings` | integration | same | ❌ Wave 0 |
| DATA-02 | `failJob` sets `status='failed'`, `error_code` | integration | same | ❌ Wave 0 |
| DATA-03 | Startup throws if `DATABASE_URL` unset | unit | `vitest run src/client.test.ts` | ❌ Wave 0 |
| DATA-04 | `runMigrations()` is idempotent (run twice = no error) | integration | `vitest run src/migrate.test.ts` | ❌ Wave 0 |
| DATA-04 | `migrate:status` lists applied versions | integration | same | ❌ Wave 0 |
| WORK-01 | `reclaimExpired` flips `running` rows past lease back to `queued` | integration | `vitest run src/dal.test.ts` | ❌ Wave 0 |
| WORK-01 | `reclaimExpired` marks `failed` when `attempts >= maxAttempts` | integration | same | ❌ Wave 0 |

**Concurrency test note:** The two-concurrent-claimers test must use `Promise.all` with two `claimNextJob()` calls against a DB seeded with exactly two `queued` rows. If both return different IDs — SKIP LOCKED is working. If one returns `null` — that's also acceptable (one claimer skipped the locked row and found nothing). What's NOT acceptable: both returning the same ID.

```typescript
// Concurrency proof pattern
const [a, b] = await Promise.all([claimNextJob(), claimNextJob()]);
const ids = [a?.id, b?.id].filter(Boolean);
expect(new Set(ids).size).toBe(ids.length); // no duplicates
```

### Sampling Rate
- **Per task commit:** `bun run test --cwd packages/db --run src/client.test.ts` (unit only, no DB needed)
- **Per wave merge:** `DATABASE_URL=<dev-db> bun run test --cwd packages/db --run`
- **Phase gate:** Full suite green (requires `DATABASE_URL`) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/db/src/client.test.ts` — unit test for DATABASE_URL guard (no DB needed)
- [ ] `packages/db/src/dal.test.ts` — integration tests (DATA-01, DATA-02, WORK-01); skips if no `DATABASE_URL`
- [ ] `packages/db/src/migrate.test.ts` — migration idempotency (DATA-04); skips if no `DATABASE_URL`
- [ ] `packages/db/vitest.config.ts` — vitest config matching workspace convention
- [ ] `packages/db/tsconfig.json` — mirrors `@geo/core`/`@geo/fetch` tsconfig

---

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | Yes | `postgres.js` tagged templates — parameterization structural |
| V6 Cryptography | No | No crypto operations in this phase |
| V2 Authentication | No | Auth is Phase 5 |
| V4 Access Control | No | Single-service internal DB |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via URL/findings input | Tampering | postgres.js tagged templates (structural, not escape-based) |
| `DATABASE_URL` in source control | Info Disclosure | D-03: env-only; `.env.example` placeholder; `.gitignore` `.env` |
| `tx.unsafe()` misuse | Tampering | Scope `.unsafe()` to migration runner only; add lint comment |

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `pg` (node-postgres) callbacks | `postgres.js` tagged templates | 2019+ | Cleaner API, structural parameterization, better Bun compat |
| Redis-backed job queues | `SELECT FOR UPDATE SKIP LOCKED` | Postgres 9.5 (2016) | No broker; durable in same DB; simpler ops |
| `pgcrypto` for uuid generation | `gen_random_uuid()` built-in | Postgres 13 (2020) | No extension needed |
| Postgres ENUM for state | CHECK-constrained text | best practice | Additive evolution with no lock; rollback-safe |

**Deprecated/outdated:**
- `pg_advisory_lock` for queue: superseded by SKIP LOCKED for row-level job dispatch
- Migration frameworks (Flyway, liquibase, node-pg-migrate) for <5 files: overkill; a 40-line runner is correct

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Bun.sql has active production bugs in Bun 1.3.14 (connection leak, txn hang) | Standard Stack / Pitfalls | If fixed, Bun.sql would be a viable alternative — but D-02 locks `postgres.js` regardless |
| A2 | `@testcontainers/postgresql` scoped package passes slopcheck | Package Legitimacy Audit | Low risk — official testcontainers org package |

---

## Open Questions (RESOLVED)

1. **Coolify dev Postgres for test `DATABASE_URL`** — **RESOLVED:** No dev Postgres/Docker available locally. Test strategy uses PGlite (`@electric-sql/pglite`) for all runnable migrate/schema/lifecycle/reclaim tests; the true-concurrency SKIP LOCKED test is gated behind a real `DATABASE_URL` (skipped-with-reason when absent) per `03-VALIDATION.md`, and concurrency is proven against live Coolify Postgres in Phase 6 (DEPLOY-04). No Wave 0 provisioning task needed.

2. **`findings` jsonb shape** — **RESOLVED:** `@geo/db` imports `@geo/core` result types (same monorepo workspace); does NOT re-declare. Enforced in Plan 03-02 Task 1 action.

---

## Sources

### Primary (HIGH confidence)
- github.com/porsager/postgres — postgres.js README, transaction API, `.unsafe()` docs, Bun compatibility
- PostgreSQL docs FOR UPDATE SKIP LOCKED — Postgres 9.5+ row-level locking
- npm registry — `postgres@3.4.9` (created 2015, modified 2026-04-05), `testcontainers@12.0.1`, `@testcontainers/postgresql@12.0.1`
- slopcheck v0.6.1 — `postgres` [OK], `testcontainers` [OK]

### Secondary (MEDIUM confidence)
- InfoQ "Bun 1.2 Improves Node Compatibility and Adds Postgres Client" (2025-04) — Bun.sql introduction
- GitHub issues oven-sh/bun #23215, #21934, #30646 — Bun.sql production bug status [ASSUMED current as of Bun 1.3.14]
- GitHub testcontainers-node discussion #1115, bun issue #21342 — Bun + Testcontainers incompatibility
- Netdata Academy, DBPro Blog — SKIP LOCKED pattern correctness

### Tertiary (LOW confidence)
- None — all material claims verified against primary or secondary sources

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `postgres.js` v3.4.9 verified on npm, slopcheck OK, official Bun compat confirmed
- SKIP LOCKED semantics: HIGH — Postgres official docs + multiple cross-referenced sources
- Bun.sql bug status: MEDIUM/ASSUMED — GitHub issues as of research date; may be fixed in later Bun versions
- Testcontainers/Bun incompatibility: MEDIUM — GitHub issues confirm; Docker absent locally confirmed via `docker --version`
- Migration runner pattern: HIGH — standard practice, no framework needed

**Research date:** 2026-06-02
**Valid until:** 2026-09-01 (Bun.sql bug status should be re-checked on Bun upgrade; postgres.js stable)
