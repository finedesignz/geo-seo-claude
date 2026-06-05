/**
 * @geo/db — data-access layer (D-10).
 *
 * All queries use parameterised SQL (T-03-INJ: never string-concatenate user values).
 * createAuditDal accepts a SqlExecutor so tests can inject a PGlite adapter while
 * production passes the postgres.js sql instance.
 *
 * Security notes:
 * - All user-supplied values flow through $N / positional params — never unsafe().
 * - findings is serialised via JSON.stringify before insert (no sql.json dependency
 *   in the portable executor interface).
 * - lease_token fencing: completeJob/failJob/renewLease require matching lease_token
 *   so stale workers cannot corrupt state (T-03-DBLCLAIM).
 */

import type { AuditJob, AuditStatus, FindingsShape, InsertJobInput, PaginationInput } from "./types.js";

// ---------------------------------------------------------------------------
// Portable SQL executor interface
// Satisfied by a PGlite DbHandle adapter (tests) or a postgres.js sql wrapper.
// ---------------------------------------------------------------------------

export interface SqlExecutor {
  /**
   * Execute a parameterised query returning typed rows.
   * Params are positional ($1, $2, …).
   */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;

  /**
   * Execute a function inside a transaction.
   * The callback receives a SqlExecutor bound to the transaction connection.
   * Returns whatever the callback returns.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Row type coming back from the DB (snake_case)
// ---------------------------------------------------------------------------

interface AuditRow extends Record<string, unknown> {
  id: string;
  url: string;
  normalized_url: string;
  url_hash: string;
  status: AuditStatus;
  score: number | null;
  findings: FindingsShape | null;
  error_code: string | null;
  callback_url: string | null;
  consumer_id: string | null;
  attempts: number;
  locked_at: Date | string | null;
  lease_expires_at: Date | string | null;
  lease_token: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

// ---------------------------------------------------------------------------
// Row → AuditJob mapper
// ---------------------------------------------------------------------------

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return new Date(v);
}

function toDateRequired(v: Date | string | null | undefined): Date {
  if (v == null) throw new Error("Expected non-null date");
  if (v instanceof Date) return v;
  return new Date(v);
}

function rowToJob(row: AuditRow): AuditJob {
  // findings may come back as a string from PGlite (jsonb stored as text)
  let findings: FindingsShape | null = null;
  if (row.findings != null) {
    if (typeof row.findings === "string") {
      findings = JSON.parse(row.findings) as FindingsShape;
    } else {
      findings = row.findings;
    }
  }

  return {
    id: row.id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    urlHash: row.url_hash,
    status: row.status,
    score: row.score ?? null,
    findings,
    errorCode: row.error_code ?? null,
    callbackUrl: row.callback_url ?? null,
    consumerId: row.consumer_id ?? null,
    attempts: row.attempts,
    lockedAt: toDate(row.locked_at),
    leaseExpiresAt: toDate(row.lease_expires_at),
    leaseToken: row.lease_token ?? null,
    createdAt: toDateRequired(row.created_at),
    updatedAt: toDateRequired(row.updated_at),
    startedAt: toDate(row.started_at),
    finishedAt: toDate(row.finished_at),
  };
}

// ---------------------------------------------------------------------------
// DAL factory
// ---------------------------------------------------------------------------

export interface AuditDal {
  insertJob(input: InsertJobInput): Promise<AuditJob>;
  claimNextJob(leaseSecs?: number): Promise<AuditJob | null>;
  completeJob(id: string, leaseToken: string, score: number, findings: FindingsShape): Promise<boolean>;
  failJob(id: string, leaseToken: string, errorCode: string): Promise<boolean>;
  /**
   * Requeue a running job back to queued status (D-15).
   * Lease-fenced: only updates rows WHERE id=$id AND lease_token=$tok AND status='running'.
   * Records errorCode so the failure reason is preserved across attempts.
   * Does NOT touch attempts (already incremented at claim).
   * Returns true if the row was updated, false if the lease was stale/lost.
   */
  requeueJob(id: string, leaseToken: string, errorCode: string): Promise<boolean>;
  renewLease(id: string, leaseToken: string, secs: number): Promise<boolean>;
  getJob(id: string): Promise<AuditJob | null>;
  listJobs(pagination: PaginationInput): Promise<AuditJob[]>;
  findRecentByUrlHash(urlHash: string, ttlMs: number, consumerId: string): Promise<AuditJob | null>;
  reclaimExpired(maxAttempts?: number): Promise<number>;
  /**
   * Deep liveness probe (API-06 / D-07): runs `SELECT 1` against the DB.
   * Resolves on success; throws if the connection is unreachable/closed so a
   * caller (GET /healthz) can return 503. Parameterless, no side effects.
   */
  ping(): Promise<void>;
}

export function createAuditDal(executor: SqlExecutor): AuditDal {

  async function reclaimExpired(maxAttempts = 3): Promise<number> {
    // D-09 / Pitfall 3: single atomic UPDATE — no prior SELECT.
    // Rows where status='running' AND lease_expires_at < now() are atomically
    // flipped: attempts >= maxAttempts → 'failed'; else → 'queued'.
    // Lease columns are cleared in both cases.
    const rows = await executor.query<{ id: string }>(
      `UPDATE audits
          SET status           = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
              error_code       = CASE WHEN attempts >= $1 THEN 'max_attempts_exceeded' ELSE NULL END,
              lease_token      = NULL,
              locked_at        = NULL,
              lease_expires_at = NULL,
              updated_at       = now()
        WHERE status = 'running'
          AND lease_expires_at < now()
        RETURNING id`,
      [maxAttempts],
    );
    return rows.length;
  }

  return {
    // -------------------------------------------------------------------------
    // insertJob
    // -------------------------------------------------------------------------
    async insertJob(input: InsertJobInput): Promise<AuditJob> {
      const rows = await executor.query<AuditRow>(
        `INSERT INTO audits (url, normalized_url, url_hash, callback_url, consumer_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [input.url, input.normalizedUrl, input.urlHash, input.callbackUrl ?? null, input.consumerId ?? null],
      );
      const row = rows[0];
      if (!row) throw new Error("insertJob: no row returned");
      return rowToJob(row);
    },

    // -------------------------------------------------------------------------
    // claimNextJob — D-08: single transaction, SKIP LOCKED
    // -------------------------------------------------------------------------
    async claimNextJob(leaseSecs = 300): Promise<AuditJob | null> {
      return executor.transaction(async (tx) => {
        // Step A: reclaim expired leases so they become claimable
        await reclaimExpiredWith(tx);

        // Step B: select next queued row with lock — SKIP LOCKED so concurrent
        // claimers bypass each other rather than blocking (WORK-01)
        const selected = await tx.query<AuditRow>(
          `SELECT * FROM audits
            WHERE status = 'queued'
            ORDER BY created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
          [],
        );

        if (selected.length === 0) return null;

        const candidate = selected[0]!;

        // Step C: atomically update in the SAME transaction (Pitfall 1 — never
        // commit between SELECT and UPDATE; the lock must hold to the UPDATE commit)
        const updated = await tx.query<AuditRow>(
          `UPDATE audits
              SET status           = 'running',
                  lease_token      = gen_random_uuid(),
                  locked_at        = now(),
                  lease_expires_at = now() + ($1::int * interval '1 second'),
                  started_at       = now(),
                  attempts         = attempts + 1,
                  updated_at       = now()
            WHERE id = $2
            RETURNING *`,
          [leaseSecs, candidate.id],
        );

        const row = updated[0];
        if (!row) return null;
        return rowToJob(row);
      });
    },

    // -------------------------------------------------------------------------
    // completeJob — running → done, fenced by lease_token
    // -------------------------------------------------------------------------
    async completeJob(id: string, leaseToken: string, score: number, findings: FindingsShape): Promise<boolean> {
      const rows = await executor.query<{ id: string }>(
        `UPDATE audits
            SET status           = 'done',
                score            = $3,
                findings         = $4::jsonb,
                finished_at      = now(),
                lease_token      = NULL,
                locked_at        = NULL,
                lease_expires_at = NULL,
                updated_at       = now()
          WHERE id          = $1
            AND lease_token = $2::uuid
            AND status      = 'running'
          RETURNING id`,
        [id, leaseToken, score, JSON.stringify(findings)],
      );
      return rows.length > 0;
    },

    // -------------------------------------------------------------------------
    // failJob — running → failed, fenced by lease_token
    // -------------------------------------------------------------------------
    async failJob(id: string, leaseToken: string, errorCode: string): Promise<boolean> {
      const rows = await executor.query<{ id: string }>(
        `UPDATE audits
            SET status           = 'failed',
                error_code       = $3,
                finished_at      = now(),
                lease_token      = NULL,
                locked_at        = NULL,
                lease_expires_at = NULL,
                updated_at       = now()
          WHERE id          = $1
            AND lease_token = $2::uuid
            AND status      = 'running'
          RETURNING id`,
        [id, leaseToken, errorCode],
      );
      return rows.length > 0;
    },

    // -------------------------------------------------------------------------
    // requeueJob — running → queued, fenced by lease_token (D-15)
    // -------------------------------------------------------------------------
    async requeueJob(id: string, leaseToken: string, errorCode: string): Promise<boolean> {
      const rows = await executor.query<{ id: string }>(
        `UPDATE audits
            SET status           = 'queued',
                error_code       = $3,
                lease_token      = NULL,
                locked_at        = NULL,
                lease_expires_at = NULL,
                updated_at       = now()
          WHERE id          = $1
            AND lease_token = $2::uuid
            AND status      = 'running'
          RETURNING id`,
        [id, leaseToken, errorCode],
      );
      return rows.length > 0;
    },

    // -------------------------------------------------------------------------
    // renewLease — extend lease, fenced by lease_token
    // -------------------------------------------------------------------------
    async renewLease(id: string, leaseToken: string, secs: number): Promise<boolean> {
      const rows = await executor.query<{ id: string }>(
        `UPDATE audits
            SET lease_expires_at = now() + ($3::int * interval '1 second'),
                updated_at       = now()
          WHERE id          = $1
            AND lease_token = $2::uuid
            AND status      = 'running'
          RETURNING id`,
        [id, leaseToken, secs],
      );
      return rows.length > 0;
    },

    // -------------------------------------------------------------------------
    // getJob
    // -------------------------------------------------------------------------
    async getJob(id: string): Promise<AuditJob | null> {
      const rows = await executor.query<AuditRow>(
        `SELECT * FROM audits WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) return null;
      return rowToJob(rows[0]!);
    },

    // -------------------------------------------------------------------------
    // listJobs — paginated, most recent first
    // -------------------------------------------------------------------------
    async listJobs(pagination: PaginationInput): Promise<AuditJob[]> {
      // Consumer scoping (D-11): when consumerId is provided, return ONLY that
      // consumer's rows (equality — legacy null rows excluded). When omitted
      // ($3 IS NULL), return all rows for back-compat.
      const rows = await executor.query<AuditRow>(
        `SELECT * FROM audits
          WHERE ($3::text IS NULL OR consumer_id = $3)
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [pagination.limit, pagination.offset, pagination.consumerId ?? null],
      );
      return rows.map(rowToJob);
    },

    // -------------------------------------------------------------------------
    // findRecentByUrlHash — dedup support (Phase 5 API-04)
    // -------------------------------------------------------------------------
    async findRecentByUrlHash(urlHash: string, ttlMs: number, consumerId: string): Promise<AuditJob | null> {
      const ttlSecs = ttlMs / 1000;
      // Consumer-scoped dedup (D-04/D-11): equality filter only. Legacy
      // null-consumer rows must NOT match, and one consumer must never dedup
      // against another consumer's job.
      const rows = await executor.query<AuditRow>(
        `SELECT * FROM audits
          WHERE url_hash    = $1
            AND consumer_id = $3
            AND created_at > now() - ($2::numeric * interval '1 second')
          ORDER BY created_at DESC
          LIMIT 1`,
        [urlHash, ttlSecs, consumerId],
      );
      if (rows.length === 0) return null;
      return rowToJob(rows[0]!);
    },

    // -------------------------------------------------------------------------
    // ping — deep liveness probe (API-06 / D-07). Throws if DB unreachable.
    // -------------------------------------------------------------------------
    async ping(): Promise<void> {
      await executor.query<{ ["?column?"]: number }>(`SELECT 1`, []);
    },

    // -------------------------------------------------------------------------
    // reclaimExpired — exposed directly (no executor capture needed, uses outer fn)
    // -------------------------------------------------------------------------
    reclaimExpired,
  };
}

// Inner helper used inside claimNextJob's transaction
async function reclaimExpiredWith(tx: SqlExecutor, maxAttempts = 3): Promise<void> {
  await tx.query<{ id: string }>(
    `UPDATE audits
        SET status           = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
            error_code       = CASE WHEN attempts >= $1 THEN 'max_attempts_exceeded' ELSE NULL END,
            lease_token      = NULL,
            locked_at        = NULL,
            lease_expires_at = NULL,
            updated_at       = now()
      WHERE status = 'running'
        AND lease_expires_at < now()
      RETURNING id`,
    [maxAttempts],
  );
}

// ---------------------------------------------------------------------------
// Default production DAL (lazy getSql + assertDatabaseUrl)
// ---------------------------------------------------------------------------

let _defaultDal: AuditDal | undefined;

/**
 * Returns a memoized AuditDal backed by the production postgres.js client.
 * Throws immediately if DATABASE_URL is not set (fail-fast, DATA-03).
 * Import getSql lazily so this module can be imported without DATABASE_URL set.
 */
export function getDefaultDal(): AuditDal {
  if (_defaultDal) return _defaultDal;

  // Lazy import to avoid triggering assertDatabaseUrl at module load time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSql } = require("./client.js") as { getSql: () => import("postgres").Sql };
  const sql = getSql();

  // Wrap postgres.js sql into SqlExecutor
  const executor = makePgExecutor(sql);
  _defaultDal = createAuditDal(executor);
  return _defaultDal;
}

/**
 * Wrap a postgres.js Sql instance into the SqlExecutor interface.
 * postgres.js `sql` does not use $N positional params — it uses tagged templates.
 * We use sql.unsafe() with positional params here since the DAL itself uses $N
 * placeholders in its SQL strings. All values are still parameterised (never
 * concatenated), so injection risk is equivalent to tagged templates.
 *
 * Note: unsafe() here refers only to the query-compilation path (bypassing the
 * template-literal type checker), NOT to unsanitised input. Values array is always
 * passed separately. This is acceptable per D-02 / T-03-INJ analysis.
 */
export function makePgExecutor(sql: import("postgres").Sql): SqlExecutor {
  return {
    async query<T extends Record<string, unknown>>(
      queryStr: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const rows = await sql.unsafe(queryStr, params as import("postgres").ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      // postgres.js sql.begin returns Promise<UnwrapPromiseArray<T>> which causes
      // a TS inference issue; cast through unknown to satisfy the generic.
      return sql.begin(async (txSql) => {
        const txExecutor = makePgExecutor(txSql as unknown as import("postgres").Sql);
        return fn(txExecutor);
      }) as unknown as Promise<T>;
    },
  };
}

/** Reset default DAL for tests. @internal */
export function _resetDefaultDalForTests(): void {
  _defaultDal = undefined;
}
