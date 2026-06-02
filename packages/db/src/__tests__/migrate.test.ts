/**
 * Migration runner tests (DATA-04).
 *
 * Verifies idempotency and transactional rollback against PGlite.
 * No Docker required.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { makePgliteDb, type DbHandle } from "./harness.js";
import { runMigrations, listApplied } from "../migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DbHandle;

beforeEach(async () => {
  db = await makePgliteDb();
});

afterEach(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("runMigrations", () => {
  it("applies 0001 on a fresh DB and returns the version", async () => {
    const applied = await runMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual(["0001_create_audits"]);
  });

  it("is idempotent — second call applies nothing", async () => {
    await runMigrations(db, MIGRATIONS_DIR);
    const second = await runMigrations(db, MIGRATIONS_DIR);
    expect(second).toEqual([]);
  });

  it("listApplied shows applied version after migrate", async () => {
    await runMigrations(db, MIGRATIONS_DIR);
    const versions = await listApplied(db);
    expect(versions).toEqual(["0001_create_audits"]);
  });

  it("listApplied returns [] before any migration", async () => {
    const versions = await listApplied(db);
    expect(versions).toEqual([]);
  });

  it("rolls back a failing migration and does not record the version", async () => {
    // Create a temp migrations dir with a bad SQL file
    const tmpDir = await mkdtemp(join(tmpdir(), "geo-db-test-"));
    try {
      await writeFile(
        join(tmpDir, "0001_bad.sql"),
        "CREATE TABLE this_will_fail (id REFERENCES nonexistent_table(id));",
      );
      await expect(runMigrations(db, tmpDir)).rejects.toThrow();
      // schema_migrations should be empty (or the version not recorded)
      const applied = await listApplied(db);
      expect(applied).not.toContain("0001_bad");
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("applies migrations in lexicographic order", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "geo-db-order-"));
    try {
      await writeFile(
        join(tmpDir, "0001_alpha.sql"),
        "CREATE TABLE alpha_table (id serial PRIMARY KEY);",
      );
      await writeFile(
        join(tmpDir, "0002_beta.sql"),
        "CREATE TABLE beta_table (id serial PRIMARY KEY);",
      );
      const applied = await runMigrations(db, tmpDir);
      expect(applied).toEqual(["0001_alpha", "0002_beta"]);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});
