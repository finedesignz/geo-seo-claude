/**
 * True-concurrency double-claim test — gated behind DATABASE_URL + ALLOW_DB_TESTS=1.
 *
 * PGlite is single-connection and CANNOT prove true SKIP LOCKED concurrency semantics.
 * This file is skipped (describeIfRealDb → describe.skip) when DATABASE_URL is absent
 * or ALLOW_DB_TESTS is not set to "1".
 *
 * When a real Postgres DATABASE_URL IS provided:
 *   - Migrates a fresh schema
 *   - Seeds two queued rows
 *   - Issues two concurrent claimNextJob() calls via Promise.all
 *   - Asserts the two claimers received DIFFERENT row ids (WORK-01 concurrency proof)
 *
 * Deferred to Phase 6 DEPLOY-04: this test runs against the live Coolify Postgres
 * instance once DATABASE_URL is provisioned. See 03-VALIDATION.md Manual-Only/Deferred.
 *
 * IMPORTANT: Do NOT mock SKIP LOCKED semantics here — mocking proves nothing (D-11).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import {
  describeIfRealDb,
  hasRealDb,
  assertTestDatabaseUrl,
} from "./harness.js";
import { runMigrations } from "../migrate.js";
import { createAuditDal, makePgExecutor } from "../dal.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

// Log skip reason so CI output is self-documenting
if (!hasRealDb()) {
  console.log(
    "[concurrency.test] SKIPPED — DATABASE_URL not set or ALLOW_DB_TESTS != '1'. " +
      "True SKIP LOCKED concurrency proof is deferred to Phase 6 DEPLOY-04 against " +
      "the live Coolify Postgres instance.",
  );
}

describeIfRealDb("WORK-01: true concurrent claimNextJob — no double-claim", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sql: any;

  beforeAll(async () => {
    const url = process.env["DATABASE_URL"]!;
    assertTestDatabaseUrl(url);

    const postgres = (await import("postgres")).default;
    sql = postgres(url, { max: 5 });

    // Migrate fresh schema
    const executor = makePgExecutor(sql);
    await runMigrations(
      {
        exec: (s: string) => sql.unsafe(s),
        query: <T extends Record<string, unknown>>(s: string, p?: unknown[]) =>
          sql.unsafe(s, p ?? []) as Promise<T[]>,
      },
      MIGRATIONS_DIR,
    );
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  it("two concurrent claimers receive different row ids (SKIP LOCKED proof)", async () => {
    const dal = createAuditDal(makePgExecutor(sql));

    // Seed two queued rows
    const [j1, j2] = await Promise.all([
      dal.insertJob({ url: "https://concurrent-a.com", normalizedUrl: "https://concurrent-a.com", urlHash: "conc-a" }),
      dal.insertJob({ url: "https://concurrent-b.com", normalizedUrl: "https://concurrent-b.com", urlHash: "conc-b" }),
    ]);
    expect(j1.id).not.toBe(j2.id);

    // Two concurrent claim attempts
    const [a, b] = await Promise.all([
      dal.claimNextJob(300),
      dal.claimNextJob(300),
    ]);

    // Both should succeed — two rows available
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const ids = [a!.id, b!.id];
    // WORK-01: no double-claim — each claimer got a distinct row
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// Minimal describe block so this file always produces at least one test entry
// (vitest requires at least one test/describe when the file is collected).
describe("concurrency: gate documentation", () => {
  it("documents that true-concurrency proof is deferred to Phase 6 DEPLOY-04", () => {
    // This test always passes — it exists to make the skip reason visible in test output.
    // PGlite is single-connection and cannot prove concurrent SKIP LOCKED behaviour.
    // The runtime proof completes when ALLOW_DB_TESTS=1 + a test-named DATABASE_URL are set.
    expect(true).toBe(true);
  });
});
