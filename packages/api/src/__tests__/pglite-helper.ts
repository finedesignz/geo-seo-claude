/**
 * PGlite test helper for @geo/api.
 *
 * Reuses @geo/db's harness + executor + migration runner (no reimplementation).
 * Imports the db source directly by relative path so the real DAL runs against
 * an in-memory PGlite DB with the real migrations applied (TEST DB SAFETY: never
 * the prod DATABASE_URL).
 */

import { join } from "node:path";
import { makePgliteDb } from "../../../db/src/__tests__/harness.js";
import { makePgliteExecutor } from "../../../db/src/__tests__/pglite-executor.js";
import { runMigrations } from "../../../db/src/migrate.js";
import { createAuditDal } from "../../../db/src/dal.js";
import type { AuditDal } from "../../../db/src/dal.js";
import type { DbHandle } from "../../../db/src/__tests__/harness.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

export interface TestDal {
  dal: AuditDal;
  db: DbHandle;
}

/** Fresh PGlite DB with @geo/db migrations applied + a real AuditDal over it. */
export async function makeTestDal(): Promise<TestDal> {
  const db = await makePgliteDb();
  await runMigrations(db, MIGRATIONS_DIR);
  const dal = createAuditDal(makePgliteExecutor(db));
  return { dal, db };
}
