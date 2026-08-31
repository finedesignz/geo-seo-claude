/**
 * Lifecycle tests: full queued → running → done | failed state transitions
 * using PGlite (in-process WASM Postgres, no Docker required).
 *
 * Covers DATA-01 (typed DAL reads/writes), DATA-02 (durable state machine).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { makePgliteDb } from "./harness.js";
import { runMigrations } from "../migrate.js";
import { createAuditDal } from "../dal.js";
import { makePgliteExecutor } from "./pglite-executor.js";
import type { DbHandle } from "./harness.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

describe("lifecycle: queued → running → done", () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it("insertJob persists a queued row and getJob returns all typed fields", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));

    const job = await dal.insertJob({
      url: "https://example.com/",
      normalizedUrl: "https://example.com",
      urlHash: "abc123",
      callbackUrl: "https://hook.example.com/cb",
    });

    expect(job.id).toBeTruthy();
    expect(job.url).toBe("https://example.com/");
    expect(job.normalizedUrl).toBe("https://example.com");
    expect(job.urlHash).toBe("abc123");
    expect(job.callbackUrl).toBe("https://hook.example.com/cb");
    expect(job.status).toBe("queued");
    expect(job.score).toBeNull();
    expect(job.findings).toBeNull();
    expect(job.errorCode).toBeNull();
    expect(job.attempts).toBe(0);
    expect(job.leaseToken).toBeNull();
    expect(job.lockedAt).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.updatedAt).toBeInstanceOf(Date);

    const fetched = await dal.getJob(job.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job.id);
    expect(fetched!.status).toBe("queued");
  });

  it("insertJob without callbackUrl sets callbackUrl null", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const job = await dal.insertJob({
      url: "https://example.com/no-cb",
      normalizedUrl: "https://example.com/no-cb",
      urlHash: "no-cb-hash",
    });
    expect(job.callbackUrl).toBeNull();
  });

  it("claimNextJob transitions queued → running with correct fields", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const inserted = await dal.insertJob({
      url: "https://example.com/a",
      normalizedUrl: "https://example.com/a",
      urlHash: "hash-a",
    });

    const before = Date.now();
    const claimed = await dal.claimNextJob(300);
    const after = Date.now();

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(inserted.id);
    expect(claimed!.status).toBe("running");
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.leaseToken).toBeTruthy(); // UUID assigned
    expect(claimed!.lockedAt).toBeInstanceOf(Date);
    expect(claimed!.startedAt).toBeInstanceOf(Date);
    expect(claimed!.leaseExpiresAt).toBeInstanceOf(Date);

    // lease_expires_at should be ~300 seconds in the future
    const leaseMs = claimed!.leaseExpiresAt!.getTime();
    expect(leaseMs).toBeGreaterThan(before + 290_000);
    expect(leaseMs).toBeLessThan(after + 310_000);
  });

  it("claimNextJob returns null when no queued rows", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const result = await dal.claimNextJob();
    expect(result).toBeNull();
  });

  it("completeJob transitions running → done", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({
      url: "https://example.com/b",
      normalizedUrl: "https://example.com/b",
      urlHash: "hash-b",
    });

    const claimed = await dal.claimNextJob(300);
    expect(claimed).not.toBeNull();

    const findings = {
      citability: {
        score: 88,
        breakdown: { title: 20, content: 40, metadata: 28 },
        signals: ["has-title"],
        errors: [],
      },
    };

    const ok = await dal.completeJob(claimed!.id, claimed!.leaseToken!, 88, findings);
    expect(ok).toBe(true);

    const done = await dal.getJob(claimed!.id);
    expect(done!.status).toBe("done");
    expect(done!.score).toBe(88);
    expect(done!.findings).toEqual(findings);
    expect(done!.finishedAt).toBeInstanceOf(Date);
    // Terminal state: lease columns cleared
    expect(done!.leaseToken).toBeNull();
    expect(done!.lockedAt).toBeNull();
    expect(done!.leaseExpiresAt).toBeNull();
  });

  it("failJob transitions running → failed", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({
      url: "https://example.com/c",
      normalizedUrl: "https://example.com/c",
      urlHash: "hash-c",
    });

    const claimed = await dal.claimNextJob(300);
    expect(claimed).not.toBeNull();

    const ok = await dal.failJob(claimed!.id, claimed!.leaseToken!, "FETCH_ERROR");
    expect(ok).toBe(true);

    const failed = await dal.getJob(claimed!.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.errorCode).toBe("FETCH_ERROR");
    expect(failed!.finishedAt).toBeInstanceOf(Date);
    // Terminal state: lease columns cleared
    expect(failed!.leaseToken).toBeNull();
    expect(failed!.lockedAt).toBeNull();
    expect(failed!.leaseExpiresAt).toBeNull();
  });

  it("getJob returns null for unknown id", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    const result = await dal.getJob("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

describe("lifecycle: lease fencing", () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(async () => {
    await db.close();
  });

  it("completeJob with wrong lease_token returns false, no state change", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://x.com", normalizedUrl: "https://x.com", urlHash: "x1" });
    const claimed = await dal.claimNextJob(300);
    expect(claimed).not.toBeNull();

    const staleToken = "00000000-0000-0000-0000-000000000000";
    const ok = await dal.completeJob(claimed!.id, staleToken, 90, {});
    expect(ok).toBe(false);

    // Row must still be running
    const row = await dal.getJob(claimed!.id);
    expect(row!.status).toBe("running");
    expect(row!.leaseToken).toBe(claimed!.leaseToken);
  });

  it("failJob with wrong lease_token returns false, no state change", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://x.com/f", normalizedUrl: "https://x.com/f", urlHash: "x2" });
    const claimed = await dal.claimNextJob(300);
    expect(claimed).not.toBeNull();

    const ok = await dal.failJob(claimed!.id, "00000000-0000-0000-0000-000000000000", "ERR");
    expect(ok).toBe(false);

    const row = await dal.getJob(claimed!.id);
    expect(row!.status).toBe("running");
  });

  it("renewLease with correct token updates lease_expires_at", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://renew.com", normalizedUrl: "https://renew.com", urlHash: "renew1" });
    const claimed = await dal.claimNextJob(10); // 10s lease
    expect(claimed).not.toBeNull();

    const ok = await dal.renewLease(claimed!.id, claimed!.leaseToken!, 600);
    expect(ok).toBe(true);

    const row = await dal.getJob(claimed!.id);
    // New expiry should be ~600s from now
    expect(row!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 580_000);
  });

  it("renewLease with wrong token returns false", async () => {
    const dal = createAuditDal(makePgliteExecutor(db));
    await dal.insertJob({ url: "https://renew.com/bad", normalizedUrl: "https://renew.com/bad", urlHash: "renew2" });
    const claimed = await dal.claimNextJob(300);
    expect(claimed).not.toBeNull();

    const ok = await dal.renewLease(claimed!.id, "00000000-0000-0000-0000-000000000000", 600);
    expect(ok).toBe(false);
  });
});
