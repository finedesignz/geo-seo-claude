/**
 * postgres.js SQL client with fail-fast DATABASE_URL guard.
 *
 * Security notes (T-03-LEAK, T-03-INJ):
 * - DATABASE_URL is read from env only; never committed (see .env.example).
 * - Error messages name the variable but NEVER echo its value.
 * - All queries must use the tagged-template API (sql`…`) to prevent injection.
 * - unsafe() is reserved for the migration runner operating over trusted migration files.
 */

import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

let _sql: Sql | undefined;

/**
 * Returns the memoized postgres.js sql instance.
 * Throws immediately if DATABASE_URL is not set (DATA-03 fail-fast guard).
 */
export function getSql(): Sql {
  if (_sql !== undefined) {
    return _sql;
  }

  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "@geo/db: DATABASE_URL is required but not set. " +
        "Set DATABASE_URL in your environment (see .env.example). " +
        "Do not include a real connection string in any committed file.",
    );
  }

  _sql = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return _sql;
}

/**
 * Resets the memoized instance. For use in tests only.
 * @internal
 */
export function _resetSqlForTests(): void {
  _sql = undefined;
}
