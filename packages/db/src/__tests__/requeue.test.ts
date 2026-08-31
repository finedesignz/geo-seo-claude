/**
 * requeueJob tests (D-15) — PGlite.
 *
 * Covers:
 * (a) requeueJob with matching lease flips running→queued and the row is
 *     claimable again by claimNextJob.
 * (b) requeueJob with a WRONG lease_token returns false and leaves status unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { makePgliteDb } from "./harness.js";
import { runMigrations } from "../migrate.js";
import { createAuditDal } from "../dal.js";
import { makePgliteExecutor } from "./pglite-executor.js";
import type { DbHandle } from "./harness.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

describe("requeueJob (D-15)", () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it("(a) requeueJob with matching lease: running→queued; row re-claimable", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));

    await dal.insertJob({
      url: "https://example.com/requeue",
      normalizedUrl: "https://example.com/requeue",
      urlHash: "rq1",
    });

    const job = await dal.claimNextJob(120);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("running");
    expect(job!.leaseToken).toBeTruthy();

    const requeued = await dal.requeueJob(job!.id, job!.leaseToken!, "SCORING_TIMEOUT");
    expect(requeued).toBe(true);

    const after = await dal.getJob(job!.id);
    expect(after!.status).toBe("queued");
    expect(after!.errorCode).toBe("SCORING_TIMEOUT");
    expect(after!.leaseToken).toBeNull();
    expect(after!.lockedAt).toBeNull();
    expect(after!.leaseExpiresAt).toBeNull();
    // attempts must be unchanged (already incremented at claim time)
    expect(after!.attempts).toBe(1);

    // Row must now be claimable again
    const reclaimed = await dal.claimNextJob(120);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(job!.id);
    expect(reclaimed!.status).toBe("running");
    expect(reclaimed!.attempts).toBe(2);
  });

  it("(b) requeueJob with wrong lease_token returns false and leaves status unchanged", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));

    await dal.insertJob({
      url: "https://example.com/requeue-fence",
      normalizedUrl: "https://example.com/requeue-fence",
      urlHash: "rq2",
    });

    const job = await dal.claimNextJob(120);
    expect(job).not.toBeNull();

    const wrongToken = "00000000-0000-0000-0000-000000000000";
    const result = await dal.requeueJob(job!.id, wrongToken, "SCORING_TIMEOUT");
    expect(result).toBe(false);

    // Status must remain running
    const after = await dal.getJob(job!.id);
    expect(after!.status).toBe("running");
    expect(after!.leaseToken).toBe(job!.leaseToken);
  });
});
