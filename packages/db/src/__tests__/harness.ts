/**
 * Test harness for @geo/db.
 *
 * Two modes:
 *
 * 1. PGlite (default) — in-process WASM Postgres, no Docker required.
 *    Use makePgliteDb() to get a fresh ephemeral DB per test file.
 *    Limitation: PGlite is single-connection; it cannot prove true SKIP LOCKED
 *    concurrency semantics. Concurrency proofs are gated behind DATABASE_URL
 *    and deferred to Phase 6 (DEPLOY-04).
 *
 * 2. Real Postgres (optional) — gated by DATABASE_URL env var.
 *    Tests that require a real DB are wrapped in describeIfRealDb().
 *    A safety guard rejects DATABASE_URL values that do not look like test DBs
 *    (must contain "test", "testing", or "dev" in the database name segment).
 *    Set ALLOW_DB_TESTS=1 to enable when DATABASE_URL is present.
 *
 * NEVER set DATABASE_URL to a production connection string when running tests.
 */

import { PGlite } from "@electric-sql/pglite";
import { describe } from "vitest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DbHandle {
  /** Execute raw SQL (DDL, migration files). Returns all rows from last query. */
  exec(sql: string): Promise<void>;
  /** Execute a parameterised query, returns rows. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// PGlite factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh in-memory PGlite instance.
 * Each call returns an independent database — suitable for test-file isolation.
 */
export async function makePgliteDb(): Promise<DbHandle> {
  const db = new PGlite(); // ephemeral, no data dir

  const exec = async (sql: string): Promise<void> => {
    await db.exec(sql);
  };

  const query = async <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    const result = await db.query<T>(sql, params);
    return result.rows;
  };

  const close = async (): Promise<void> => {
    await db.close();
  };

  return { exec, query, close };
}

// ---------------------------------------------------------------------------
// Real-Postgres helpers (gated by ALLOW_DB_TESTS + DATABASE_URL)
// ---------------------------------------------------------------------------

/**
 * Returns true when a real DATABASE_URL is available AND ALLOW_DB_TESTS=1 is set.
 */
export function hasRealDb(): boolean {
  return Boolean(process.env["DATABASE_URL"]) && process.env["ALLOW_DB_TESTS"] === "1";
}

/**
 * Safety guard: rejects DATABASE_URL values that do not look like test/dev databases.
 * Throws if the DB name segment is absent or looks like a production name.
 */
export function assertTestDatabaseUrl(url: string): void {
  let dbName: string;
  try {
    const parsed = new URL(url);
    dbName = parsed.pathname.replace(/^\//, "").toLowerCase();
  } catch {
    throw new Error("@geo/db tests: DATABASE_URL is not a valid URL");
  }

  const isTestLike = /test|testing|dev/.test(dbName);
  if (!isTestLike) {
    throw new Error(
      `@geo/db tests: DATABASE_URL database name "${dbName}" does not contain "test", "testing", or "dev". ` +
        "Refusing to run tests against what appears to be a non-test database. " +
        "Rename the database or set a different DATABASE_URL.",
    );
  }
}

/**
 * vitest describe wrapper that skips when no real DB is available.
 *
 * Usage:
 *   describeIfRealDb("concurrency", () => { ... });
 *
 * Skipped with reason when ALLOW_DB_TESTS != "1" or DATABASE_URL is unset.
 */
export const describeIfRealDb: typeof describe = hasRealDb()
  ? describe
  : ((...args: Parameters<typeof describe>) => {
      // Cast through unknown to satisfy the overloaded describe signature
      (describe.skip as unknown as typeof describe)(...args);
    }) as unknown as typeof describe;
