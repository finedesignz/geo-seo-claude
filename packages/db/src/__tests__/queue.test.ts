/**
 * Queue tests: reclaimExpired, FIFO order, findRecentByUrlHash, listJobs.
 *
 * Uses PGlite (in-process WASM Postgres).
 * Also verifies structural correctness of the claim query (single-transaction,
 * SKIP LOCKED clause present) since PGlite cannot prove true concurrency.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { makePgliteDb } from "./harness.js";
import { runMigrations } from "../migrate.js";
import { createAuditDal } from "../dal.js";
import { makePgliteExecutor } from "./pglite-executor.js";
import type { DbHandle } from "./harness.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

// ---------------------------------------------------------------------------
// reclaimExpired
// ---------------------------------------------------------------------------

describe("reclaimExpired", () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it("reclaims a running row with expired lease back to queued", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const job = await dal.insertJob({ url: "https://a.com", normalizedUrl: "https://a.com", urlHash: "a1" });
    const claimed = await dal.claimNextJob(300);
    expect(claimed).not.toBeNull();

    // Manually expire the lease
    await db.exec(
      `UPDATE audits SET lease_expires_at = now() - interval '1 second' WHERE id = '${job.id}'`,
    );

    const count = await dal.reclaimExpired(3);
    expect(count).toBe(1);

    const row = await dal.getJob(job.id);
    expect(row!.status).toBe("queued");
    expect(row!.leaseToken).toBeNull();
    expect(row!.lockedAt).toBeNull();
    expect(row!.leaseExpiresAt).toBeNull();
    // attempts is preserved (incremented by claimNextJob)
    expect(row!.attempts).toBe(1);
  });

  it("transitions to failed when attempts >= maxAttempts", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const job = await dal.insertJob({ url: "https://b.com", normalizedUrl: "https://b.com", urlHash: "b1" });

    // Simulate attempts = 3 by claiming and expiring 2 times first, then final time
    // Shortcut: directly set attempts=3 + running status + expired lease
    await db.exec(
      `UPDATE audits SET status='running', attempts=3, lease_token=gen_random_uuid(),
       locked_at=now(), lease_expires_at=now()-interval '1 second' WHERE id='${job.id}'`,
    );

    const count = await dal.reclaimExpired(3); // maxAttempts=3
    expect(count).toBe(1);

    const row = await dal.getJob(job.id);
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("max_attempts_exceeded");
    expect(row!.leaseToken).toBeNull();
    expect(row!.lockedAt).toBeNull();
    expect(row!.leaseExpiresAt).toBeNull();
  });

  it("does not reclaim running rows with a future lease", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://c.com", normalizedUrl: "https://c.com", urlHash: "c1" });
    await dal.claimNextJob(300); // lease is 300s in the future

    const count = await dal.reclaimExpired(3);
    expect(count).toBe(0);
  });

  it("does not affect queued or done rows", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const j1 = await dal.insertJob({ url: "https://d.com", normalizedUrl: "https://d.com", urlHash: "d1" });
    const j2 = await dal.insertJob({ url: "https://e.com", normalizedUrl: "https://e.com", urlHash: "e1" });
    const claimed = await dal.claimNextJob(300);
    await dal.completeJob(claimed!.id, claimed!.leaseToken!, 80, {});

    const count = await dal.reclaimExpired(3);
    expect(count).toBe(0);

    const r1 = await dal.getJob(j1.id);
    const r2 = await dal.getJob(j2.id);
    // j1 was claimed and completed; j2 is queued
    expect(r2!.status).toBe("queued");
    expect(r1!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// FIFO ordering
// ---------------------------------------------------------------------------

describe("claimNextJob FIFO order", () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it("claims oldest job first (ORDER BY created_at, id)", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));

    const j1 = await dal.insertJob({ url: "https://first.com", normalizedUrl: "https://first.com", urlHash: "first" });
    // Small delay so created_at timestamps differ
    await new Promise((r) => setTimeout(r, 10));
    await dal.insertJob({ url: "https://second.com", normalizedUrl: "https://second.com", urlHash: "second" });

    const claimed = await dal.claimNextJob(300);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(j1.id);
  });
});

// ---------------------------------------------------------------------------
// findRecentByUrlHash (dedup)
// ---------------------------------------------------------------------------

describe("findRecentByUrlHash", () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it("returns the most recent job within TTL", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const job = await dal.insertJob({ url: "https://dedup.com", normalizedUrl: "https://dedup.com", urlHash: "dedup-hash", consumerId: "ottolax" });

    const found = await dal.findRecentByUrlHash("dedup-hash", 60_000, "ottolax"); // 60s TTL
    expect(found).not.toBeNull();
    expect(found!.id).toBe(job.id);
  });

  it("returns null when no job exists with that hash", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const found = await dal.findRecentByUrlHash("nonexistent-hash", 60_000, "ottolax");
    expect(found).toBeNull();
  });

  it("returns null when the job is outside the TTL window", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://old.com", normalizedUrl: "https://old.com", urlHash: "old-hash", consumerId: "ottolax" });

    // Move created_at back by 2 minutes
    await db.exec(`UPDATE audits SET created_at = now() - interval '2 minutes' WHERE url_hash = 'old-hash'`);

    // TTL = 60s → row is 120s old → outside window
    const found = await dal.findRecentByUrlHash("old-hash", 60_000, "ottolax");
    expect(found).toBeNull();
  });

  it("returns most recent row when multiple exist", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const j1 = await dal.insertJob({ url: "https://multi.com", normalizedUrl: "https://multi.com", urlHash: "multi-hash", consumerId: "ottolax" });
    await new Promise((r) => setTimeout(r, 10));
    const j2 = await dal.insertJob({ url: "https://multi.com", normalizedUrl: "https://multi.com", urlHash: "multi-hash", consumerId: "ottolax" });

    const found = await dal.findRecentByUrlHash("multi-hash", 60_000, "ottolax");
    expect(found!.id).toBe(j2.id); // most recent
    expect(found!.id).not.toBe(j1.id);
  });
});

// ---------------------------------------------------------------------------
// Consumer scoping (D-11): migration 0002 + DAL consumer_id
// ---------------------------------------------------------------------------

describe("consumer scoping (D-11)", () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it("insertJob persists consumer_id and getJob returns it", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const job = await dal.insertJob({ url: "https://c.com", normalizedUrl: "https://c.com", urlHash: "c-h", consumerId: "ottolax" });
    expect(job.consumerId).toBe("ottolax");

    const fetched = await dal.getJob(job.id);
    expect(fetched!.consumerId).toBe("ottolax");
  });

  it("insertJob without consumerId stores null (back-compat)", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const job = await dal.insertJob({ url: "https://n.com", normalizedUrl: "https://n.com", urlHash: "n-h" });
    expect(job.consumerId).toBeNull();
  });

  it("listJobs with consumerId returns only that consumer's rows", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://o1.com", normalizedUrl: "https://o1.com", urlHash: "o1", consumerId: "ottolax" });
    await dal.insertJob({ url: "https://h1.com", normalizedUrl: "https://h1.com", urlHash: "h1", consumerId: "how" });
    await dal.insertJob({ url: "https://legacy.com", normalizedUrl: "https://legacy.com", urlHash: "lg" }); // null consumer

    const ottolax = await dal.listJobs({ limit: 100, offset: 0, consumerId: "ottolax" });
    expect(ottolax.length).toBe(1);
    expect(ottolax[0]!.consumerId).toBe("ottolax");
  });

  it("listJobs without consumerId returns all rows (back-compat)", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://o2.com", normalizedUrl: "https://o2.com", urlHash: "o2", consumerId: "ottolax" });
    await dal.insertJob({ url: "https://h2.com", normalizedUrl: "https://h2.com", urlHash: "h2", consumerId: "how" });
    await dal.insertJob({ url: "https://lg2.com", normalizedUrl: "https://lg2.com", urlHash: "lg2" });

    const all = await dal.listJobs({ limit: 100, offset: 0 });
    expect(all.length).toBe(3);
  });

  it("findRecentByUrlHash is consumer-scoped (equality, legacy null excluded)", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    // same url_hash, three owners
    await dal.insertJob({ url: "https://s.com", normalizedUrl: "https://s.com", urlHash: "shared", consumerId: "how" });
    await dal.insertJob({ url: "https://s.com", normalizedUrl: "https://s.com", urlHash: "shared" }); // legacy null
    const mine = await dal.insertJob({ url: "https://s.com", normalizedUrl: "https://s.com", urlHash: "shared", consumerId: "ottolax" });

    // ottolax only sees its own row
    const forOttolax = await dal.findRecentByUrlHash("shared", 60_000, "ottolax");
    expect(forOttolax!.id).toBe(mine.id);
    expect(forOttolax!.consumerId).toBe("ottolax");

    // a consumer with no matching row gets null (does NOT match how's or the legacy null row)
    const forOther = await dal.findRecentByUrlHash("shared", 60_000, "nobody");
    expect(forOther).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listJobs pagination
// ---------------------------------------------------------------------------

describe("listJobs pagination", () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it("returns jobs ordered by created_at DESC with limit/offset", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));

    for (let i = 0; i < 5; i++) {
      await dal.insertJob({ url: `https://page.com/${i}`, normalizedUrl: `https://page.com/${i}`, urlHash: `page-${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await dal.listJobs({ limit: 2, offset: 0 });
    const page2 = await dal.listJobs({ limit: 2, offset: 2 });
    const page3 = await dal.listJobs({ limit: 2, offset: 4 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page3.length).toBe(1);

    // Ordered newest first
    expect(page1[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(page1[1]!.createdAt.getTime());

    // No overlap
    const allIds = [...page1, ...page2, ...page3].map((j) => j.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("returns empty array when offset exceeds total", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://one.com", normalizedUrl: "https://one.com", urlHash: "one" });

    const result = await dal.listJobs({ limit: 10, offset: 100 });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structural correctness of claimNextJob
// ---------------------------------------------------------------------------

describe("claimNextJob structural correctness", () => {
  it("dal.ts source contains FOR UPDATE SKIP LOCKED inside a transaction call", async () => {
    // This assertion checks the source text rather than runtime behavior,
    // because PGlite cannot prove concurrent SKIP LOCKED semantics.
    // The runtime proof is deferred to Phase 6 DEPLOY-04 against real Postgres.
    const { readFileSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");

    const dalSource = readFileSync(
      pathJoin(import.meta.dirname, "../dal.ts"),
      "utf-8",
    );

    expect(dalSource).toContain("FOR UPDATE SKIP LOCKED");
    expect(dalSource).toContain("transaction(");
    // Verify the SKIP LOCKED SELECT and UPDATE are inside the same transaction block
    const txStart = dalSource.indexOf("transaction(");
    const skipLockedPos = dalSource.indexOf("FOR UPDATE SKIP LOCKED");
    const updateSameRowPos = dalSource.indexOf("WHERE id = $2");
    expect(skipLockedPos).toBeGreaterThan(txStart);
    expect(updateSameRowPos).toBeGreaterThan(skipLockedPos);
  });
});
