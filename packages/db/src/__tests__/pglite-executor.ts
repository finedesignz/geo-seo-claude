/**
 * Adapts a PGlite DbHandle (from harness.ts) into a SqlExecutor
 * so the DAL can be tested without a real Postgres instance.
 *
 * PGlite limitation: it is single-connection and does not support
 * true concurrent transactions. SKIP LOCKED concurrency proofs are
 * deferred to Phase 6 against a real Postgres (see concurrency.test.ts).
 */

import type { DbHandle } from "./harness.js";
import type { SqlExecutor } from "../dal.js";

/**
 * Wraps a DbHandle into the SqlExecutor interface expected by createAuditDal.
 *
 * Transaction semantics: PGlite runs queries sequentially in the same process,
 * so "transaction" here is BEGIN/COMMIT wrapping — correct for state-machine
 * tests, but cannot prove SKIP LOCKED concurrency.
 */
export function makePgliteExecutor(db: DbHandle): SqlExecutor {
  const executor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      return db.query<T>(sql, params);
    },

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      await db.exec("BEGIN");
      try {
        const result = await fn(executor); // PGlite: same connection, tx is implicit
        await db.exec("COMMIT");
        return result;
      } catch (err) {
        await db.exec("ROLLBACK");
        throw err;
      }
    },
  };

  return executor;
}
