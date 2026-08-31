/**
 * Migration entrypoint for `bun run migrate` / `bun run migrate:status`.
 *
 * Usage:
 *   bun scripts/migrate.ts           — apply all pending migrations
 *   bun scripts/migrate.ts status    — print applied versions
 *
 * Connects via DATABASE_URL (must be set in the environment).
 * Migrations are resolved relative to this package, not process.cwd().
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations, listApplied, type MigrationDb } from "../src/migrate.js";
import postgres from "postgres";

// Resolve migrations dir relative to this file (package-relative, not cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/**
 * Build a DEDICATED single-connection (max: 1) postgres.js client for migrations.
 *
 * The runner (`runMigrations`) wraps each migration in a manual BEGIN/COMMIT issued
 * as separate statements. postgres.js forbids manual transactions over a connection
 * POOL (max > 1) — it raises `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or
 * max: 1` because consecutive statements can land on different pooled connections.
 * The shared app pool (getSql, max: 10) therefore cannot run migrations; a single
 * pinned connection makes the manual transaction safe and also serialises the run.
 * (Tests use the single-connection PGlite executor, which never hit this path.)
 */
function getMigrationSql(): ReturnType<typeof postgres> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "@geo/db: DATABASE_URL is required but not set. " +
        "Set DATABASE_URL in your environment (see .env.example). " +
        "Do not include a real connection string in any committed file.",
    );
  }
  return postgres(url, { max: 1, connect_timeout: 10 });
}

// Wrap postgres.js sql instance to satisfy MigrationDb interface
function wrapSql(sql: ReturnType<typeof postgres>): MigrationDb {
  return {
    async exec(sqlText: string): Promise<void> {
      // T-03-UNSAFE: exec is called only with migration file SQL (trusted source)
      await sql.unsafe(sqlText);
    },
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sqlText: string,
      params?: unknown[],
    ): Promise<T[]> {
      const rows = await sql.unsafe<T[]>(sqlText, params as unknown[]);
      return rows as T[];
    },
  };
}

const subcommand = process.argv[2];

if (subcommand === "status") {
  const sql = getMigrationSql();
  const db = wrapSql(sql);
  const applied = await listApplied(db);
  if (applied.length === 0) {
    console.log("[migrate:status] No migrations applied yet.");
  } else {
    console.log(`[migrate:status] Applied migrations (${applied.length}):`);
    for (const v of applied) {
      console.log(`  ✓ ${v}`);
    }
  }
  await sql.end();
} else {
  const sql = getMigrationSql();
  const db = wrapSql(sql);
  const applied = await runMigrations(db, MIGRATIONS_DIR);
  if (applied.length === 0) {
    console.log("[migrate] No pending migrations.");
  } else {
    console.log(`[migrate] Applied ${applied.length} migration(s):`);
    for (const v of applied) {
      console.log(`  ✓ ${v}`);
    }
  }
  await sql.end();
}
