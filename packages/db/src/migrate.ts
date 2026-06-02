/**
 * Idempotent versioned migration runner (DATA-04).
 *
 * Design:
 * - Records applied versions in `schema_migrations` (version PK).
 * - Applies each NNNN_*.sql file in lexicographic order inside its own transaction.
 * - Advisory lock (pg_advisory_lock) prevents concurrent instances from double-applying.
 *   PGlite supports pg_advisory_lock via SQL; if unsupported the runner logs a warning
 *   and continues without the lock (safe for single-connection PGlite in tests).
 *
 * Security (T-03-UNSAFE):
 * - tx.unsafe() / exec() is used ONLY for migration files that are committed, reviewed
 *   code — never for runtime or user-supplied input.
 * - All DAL queries (plan 02+) must use parameterised tagged templates.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Portable DB interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface accepted by runMigrations / listApplied.
 * Satisfied by both the postgres.js `sql` instance (production) and the
 * PGlite DbHandle returned by makePgliteDb() (tests).
 */
export interface MigrationDb {
  /**
   * Execute raw DDL / multi-statement SQL without parameterisation.
   * MUST NOT be called with any runtime or user-supplied input.
   */
  exec(sql: string): Promise<void>;

  /**
   * Execute a parameterised query and return typed rows.
   */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Advisory lock key (arbitrary fixed integer, stable across deploys)
// ---------------------------------------------------------------------------
// Stable advisory lock key: decimal encoding of "geoseo" ascii bytes
const ADVISORY_LOCK_KEY = 6473656073656; // unique fixed integer for geo-seo migrations

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Apply all pending migrations from `migrationsDir` to `db`.
 *
 * 1. Acquires an advisory session lock so only one runner proceeds at a time.
 *    PGlite may not support pg_advisory_lock; the runner catches the error and
 *    continues without the lock (single-connection, safe for tests).
 * 2. Ensures `schema_migrations` table exists.
 * 3. Reads .sql files in sorted order, skips already-applied versions.
 * 4. Each pending migration runs in a transaction; failure rolls it back and
 *    re-throws so the caller can surface the error.
 * 5. Releases the advisory lock.
 *
 * @param db           - A MigrationDb instance (postgres.js sql or PGlite DbHandle).
 * @param migrationsDir - Absolute path to the directory containing NNNN_*.sql files.
 * @returns List of version strings that were applied during this call.
 */
export async function runMigrations(
  db: MigrationDb,
  migrationsDir: string,
): Promise<string[]> {
  // 1. Advisory lock (best-effort — PGlite may not support it)
  let lockAcquired = false;
  try {
    await db.exec(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    lockAcquired = true;
  } catch {
    // PGlite or unsupported extension: log and proceed (single-connection, safe)
    console.warn(
      "[migrate] pg_advisory_lock unavailable — proceeding without distributed lock " +
        "(safe for single-connection PGlite; not safe for concurrent production instances).",
    );
  }

  try {
    // 2. Ensure schema_migrations table exists
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text        PRIMARY KEY,
        applied_at timestamptz DEFAULT now()
      )
    `);

    // 3. Discover migration files
    const files = await readdir(migrationsDir);
    const sqlFiles = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort(); // lexicographic = numeric order for NNNN prefix

    // 4. Fetch already-applied versions
    const applied = await listApplied(db);
    const appliedSet = new Set(applied);

    const appliedNow: string[] = [];

    for (const file of sqlFiles) {
      const version = file.replace(/\.sql$/, "");
      if (appliedSet.has(version)) {
        continue; // already applied — skip
      }

      const sqlText = await readFile(join(migrationsDir, file), "utf-8");

      // 5. Run migration + record version in a single transaction.
      //
      // T-03-UNSAFE: exec() is called with a migration file we own —
      // a committed, reviewed SQL file. NEVER call exec() with runtime or
      // user-supplied input.
      await db.exec("BEGIN");
      try {
        await db.exec(sqlText);
        await db.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [version],
        );
        await db.exec("COMMIT");
      } catch (err) {
        await db.exec("ROLLBACK");
        throw new Error(
          `[migrate] Migration "${file}" failed and was rolled back: ${String(err)}`,
        );
      }

      appliedNow.push(version);
    }

    return appliedNow;
  } finally {
    // Release advisory lock if we acquired it
    if (lockAcquired) {
      try {
        await db.exec(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
      } catch {
        // Non-fatal — session end also releases the lock
      }
    }
  }
}

/**
 * Returns the list of applied migration versions in ascending order.
 */
export async function listApplied(db: MigrationDb): Promise<string[]> {
  try {
    const rows = await db.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    return rows.map((r) => r.version);
  } catch {
    // Table may not exist yet on a completely fresh DB
    return [];
  }
}
