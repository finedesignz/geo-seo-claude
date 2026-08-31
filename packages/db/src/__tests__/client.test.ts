import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSql, _resetSqlForTests } from "../client.js";

describe("getSql – DATABASE_URL guard (DATA-03)", () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalUrl = process.env["DATABASE_URL"];
    _resetSqlForTests();
  });

  afterEach(() => {
    _resetSqlForTests();
    if (originalUrl !== undefined) {
      process.env["DATABASE_URL"] = originalUrl;
    } else {
      delete process.env["DATABASE_URL"];
    }
  });

  it("throws with a message naming DATABASE_URL when env var is unset", () => {
    delete process.env["DATABASE_URL"];
    expect(() => getSql()).toThrow(/DATABASE_URL/);
  });

  it("does not throw when DATABASE_URL is set to a non-empty string", () => {
    process.env["DATABASE_URL"] = "postgres://user:pass@localhost:5432/testdb";
    expect(() => getSql()).not.toThrow();
  });

  it("does not expose the DATABASE_URL value in the error message", () => {
    delete process.env["DATABASE_URL"];
    let caught: Error | undefined;
    try {
      getSql();
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/DATABASE_URL/);
    // Value itself must never appear (no credential leakage)
    expect(caught!.message).not.toContain("postgres://");
  });
});
