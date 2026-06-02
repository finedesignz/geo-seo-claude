import { describe, it, expect, afterEach } from "vitest";
import { makePgliteDb, hasRealDb, assertTestDatabaseUrl } from "./harness.js";
import type { DbHandle } from "./harness.js";

describe("makePgliteDb – PGlite smoke test", () => {
  let db: DbHandle | undefined;

  afterEach(async () => {
    if (db) {
      await db.close();
      db = undefined;
    }
  });

  it("runs SELECT 1 and returns a row", async () => {
    db = await makePgliteDb();
    const rows = await db.query<{ val: number }>("SELECT 1 AS val");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.val).toBe(1);
  });

  it("each call returns an independent ephemeral database", async () => {
    const a = await makePgliteDb();
    const b = await makePgliteDb();
    await a.exec("CREATE TABLE x (id INT)");
    // Table should NOT exist in db b
    await expect(b.query("SELECT * FROM x")).rejects.toThrow();
    await a.close();
    await b.close();
    db = undefined; // already closed above
  });
});

describe("hasRealDb", () => {
  it("returns false when ALLOW_DB_TESTS is not set", () => {
    const original = process.env["ALLOW_DB_TESTS"];
    delete process.env["ALLOW_DB_TESTS"];
    expect(hasRealDb()).toBe(false);
    if (original !== undefined) process.env["ALLOW_DB_TESTS"] = original;
  });
});

describe("assertTestDatabaseUrl", () => {
  it("accepts URLs with 'test' in the DB name", () => {
    expect(() =>
      assertTestDatabaseUrl("postgres://user:pass@localhost/testdb"),
    ).not.toThrow();
  });

  it("rejects URLs with production-looking DB names", () => {
    expect(() =>
      assertTestDatabaseUrl("postgres://user:pass@localhost/production"),
    ).toThrow(/test.*testing.*dev/i);
  });
});
