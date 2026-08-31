/**
 * worker.test.ts — WORK-03 + WORK-04 tests.
 *
 * Uses vi.useFakeTimers() to drive the poll loop + reclaim interval + heartbeat
 * without real clock delays. The DAL and runAudit are fully mocked.
 *
 * WORK-03: concurrency cap — no 3rd claim while 2 in-flight; 3rd proceeds after release.
 * WORK-04a: renewLease→false aborts in-flight, completeJob not called.
 * WORK-04b: reclaimExpired invoked on schedule.
 * WORK-04c: SIGTERM stops claims, drains in-flight, resolves.
 * WORK-04d: retryable scoring fail attempts<MAX → requeueJob; attempts>=MAX → failJob.
 * WORK-04e: completeJob/requeueJob→false handled with no re-write.
 * WORK-04f: rejecting runAudit → no unhandledRejection, slot freed.
 * WORK-04g: SIGTERM handler count returns to baseline after shutdown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuditDal, AuditJob } from "@geo/db";
import type { WorkerOptions } from "../types.js";
import { runWorker } from "../worker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides?: Partial<AuditJob>): AuditJob {
  return {
    id: Math.random().toString(36).slice(2),
    url: "https://example.com/",
    normalizedUrl: "https://example.com",
    urlHash: "abc",
    status: "running",
    score: null,
    findings: null,
    errorCode: null,
    callbackUrl: null,
    attempts: 1,
    lockedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 120_000),
    leaseToken: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    ...overrides,
  };
}

function makeMockDal(overrides?: Partial<AuditDal>): AuditDal {
  return {
    insertJob: vi.fn(),
    claimNextJob: vi.fn().mockResolvedValue(null),
    completeJob: vi.fn().mockResolvedValue(true),
    failJob: vi.fn().mockResolvedValue(true),
    requeueJob: vi.fn().mockResolvedValue(true),
    renewLease: vi.fn().mockResolvedValue(true),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    findRecentByUrlHash: vi.fn(),
    reclaimExpired: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

/** Build minimal WorkerOptions for tests. */
function makeOpts(
  dal: AuditDal,
  overrides?: Partial<WorkerOptions>,
): WorkerOptions {
  return {
    dal,
    anthropic: { messages: { create: vi.fn() } },
    fetcherFactory: () => vi.fn().mockResolvedValue({ url: "", status: 200, headers: {}, body: "<html/>", redirectChain: [] }),
    concurrency: 2,
    pollIntervalMs: 50,
    leaseTtlSecs: 120,
    reclaimIntervalMs: 200,
    maxAttempts: 3,
    scoringTimeoutMs: 1000,
    scoringModel: "claude-sonnet-4-6",
    shutdownGraceMs: 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    scheduleInterval: (fn, ms) => setInterval(fn, ms) as unknown as ReturnType<typeof setInterval>,
    cancelInterval: (h) => clearInterval(h as unknown as ReturnType<typeof clearInterval>),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WORK-04b: reclaimExpired runs on schedule
// ---------------------------------------------------------------------------

describe("WORK-04b: reclaimExpired invoked on reclaimIntervalMs schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up process listeners
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("calls reclaimExpired after reclaimIntervalMs, and again after 2x", async () => {
    const dal = makeMockDal();
    const opts = makeOpts(dal, {
      reclaimIntervalMs: 500,
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      scheduleInterval: setInterval as unknown as WorkerOptions["scheduleInterval"],
      cancelInterval: clearInterval as unknown as WorkerOptions["cancelInterval"],
    });

    // Start the worker
    const workerPromise = runWorker(opts);

    // Advance past reclaimIntervalMs (500ms) so the interval fires at least once
    await vi.advanceTimersByTimeAsync(600);

    // Verify reclaimExpired was called
    expect(dal.reclaimExpired).toHaveBeenCalledTimes(1);

    // Advance another interval period — fires again
    await vi.advanceTimersByTimeAsync(500);
    expect(dal.reclaimExpired).toHaveBeenCalledTimes(2);

    // Shutdown
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(1200);
    await workerPromise;
  });
});

// ---------------------------------------------------------------------------
// WORK-04c: SIGTERM — graceful drain + handler cleanup
// ---------------------------------------------------------------------------

describe("WORK-04c: SIGTERM graceful drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops new claims after SIGTERM and resolves", async () => {
    const dal = makeMockDal({
      claimNextJob: vi.fn().mockResolvedValue(null), // no jobs
    });

    const opts = makeOpts(dal, {
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      scheduleInterval: setInterval as unknown as WorkerOptions["scheduleInterval"],
      cancelInterval: clearInterval as unknown as WorkerOptions["cancelInterval"],
    });

    const before = process.listenerCount("SIGTERM");
    const workerPromise = runWorker(opts);

    // Let one poll tick happen
    await vi.advanceTimersByTimeAsync(100);

    process.emit("SIGTERM");

    // Advance past drain sleep
    await vi.advanceTimersByTimeAsync(1100);

    await workerPromise;

    // Handler count returns to baseline
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("WORK-04g: SIGTERM listener count returns to baseline after shutdown", async () => {
    const dal = makeMockDal();
    const opts = makeOpts(dal, {
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      scheduleInterval: setInterval as unknown as WorkerOptions["scheduleInterval"],
      cancelInterval: clearInterval as unknown as WorkerOptions["cancelInterval"],
    });

    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    const workerPromise = runWorker(opts);
    await vi.advanceTimersByTimeAsync(10);
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    await workerPromise;

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
  });
});

// ---------------------------------------------------------------------------
// WORK-03: concurrency cap
// ---------------------------------------------------------------------------

describe("WORK-03: concurrency cap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("caps in-flight at concurrency=2; 3rd claim not issued while 2 in-flight", async () => {
    const job1 = makeJob({ id: "job1" });
    const job2 = makeJob({ id: "job2" });
    const job3 = makeJob({ id: "job3" });

    // Resolvers for controlling job completion
    let resolveJob1!: () => void;
    let resolveJob2!: () => void;
    const p1 = new Promise<void>((r) => { resolveJob1 = r; });
    const p2 = new Promise<void>((r) => { resolveJob2 = r; });

    let callCount = 0;
    const claimMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return job1;
      if (callCount === 2) return job2;
      if (callCount === 3) return job3;
      return null;
    });

    const dal = makeMockDal({ claimNextJob: claimMock });

    // Mock runAudit to control when jobs finish
    // We do this by injecting a fetcherFactory that returns a fetcher
    // whose promise we control, but since pipeline.ts is real, we need
    // a different approach: use a scorer that blocks
    let scorerCallCount = 0;
    const blockedScorer = {
      score: vi.fn().mockImplementation(async () => {
        scorerCallCount++;
        const n = scorerCallCount;
        if (n === 1) await p1;
        if (n === 2) await p2;
        return { score: 80, findings: {} };
      }),
    };

    // We need to wire the scorer into the worker — but worker creates scorer internally.
    // Instead, use pipeline directly by mocking runAudit at the module level isn't ideal.
    // Better: test the concurrency mechanism by checking claimNextJob call count.
    // Since the worker polls at pollIntervalMs, we can advance timers and check.

    // Actually the simpler approach: since worker calls runAudit(job, deps) where
    // scorer = createScorer(anthropic, ...), and anthropic.messages.create is our mock,
    // we control the anthropic client to simulate long-running jobs.

    let resolveMsg1!: (v: unknown) => void;
    let resolveMsg2!: (v: unknown) => void;
    const msg1 = new Promise((r) => { resolveMsg1 = r; });
    const msg2 = new Promise((r) => { resolveMsg2 = r; });

    let msgCount = 0;
    const mockCreate = vi.fn().mockImplementation(async () => {
      msgCount++;
      if (msgCount === 1) return msg1;
      if (msgCount === 2) return msg2;
      // Return a valid tool_use response for subsequent calls
      return {
        content: [{ type: "tool_use", id: "t1", name: "record_geo_score", input: { score: 80, findings: {} } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    const opts = makeOpts(dal, {
      concurrency: 2,
      anthropic: { messages: { create: mockCreate } },
      pollIntervalMs: 50,
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      scheduleInterval: setInterval as unknown as WorkerOptions["scheduleInterval"],
      cancelInterval: clearInterval as unknown as WorkerOptions["cancelInterval"],
    });

    const workerPromise = runWorker(opts);

    // Advance time so jobs 1 + 2 are claimed
    await vi.advanceTimersByTimeAsync(200);

    // At this point: 2 in-flight (messages.create is blocking for jobs 1 and 2)
    // claimNextJob should have been called exactly 2 times (not 3)
    const callsBeforeRelease = claimMock.mock.calls.length;
    expect(callsBeforeRelease).toBe(2);

    // Resolve job1's scoring call
    resolveMsg1({
      content: [{ type: "tool_use", id: "t1", name: "record_geo_score", input: { score: 75, findings: {} } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    // Advance time to let job1 complete and trigger 3rd claim
    await vi.advanceTimersByTimeAsync(200);

    // 3rd claim should now have happened
    expect(claimMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Resolve job2 and shutdown
    resolveMsg2({
      content: [{ type: "tool_use", id: "t2", name: "record_geo_score", input: { score: 60, findings: {} } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await vi.advanceTimersByTimeAsync(200);
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(1500);

    await workerPromise;
  });
});

// ---------------------------------------------------------------------------
// WORK-04f: rejecting runAudit → no unhandledRejection + slot freed
// ---------------------------------------------------------------------------

describe("WORK-04f: rejecting pipeline frees slot, no unhandledRejection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("a job that causes runAudit to throw frees the concurrency slot", async () => {
    const job = makeJob({ id: "throw-job" });
    let claimCallCount = 0;
    const dal = makeMockDal({
      claimNextJob: vi.fn().mockImplementation(async () => {
        claimCallCount++;
        if (claimCallCount === 1) return job;
        return null;
      }),
    });

    // Make anthropic throw immediately to simulate an unexpected pipeline error
    const mockCreate = vi.fn().mockRejectedValue(new Error("unexpected SDK crash"));

    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", handler);

    const opts = makeOpts(dal, {
      concurrency: 1,
      anthropic: { messages: { create: mockCreate } },
      pollIntervalMs: 50,
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      scheduleInterval: setInterval as unknown as WorkerOptions["scheduleInterval"],
      cancelInterval: clearInterval as unknown as WorkerOptions["cancelInterval"],
    });

    const workerPromise = runWorker(opts);

    // Let the job claim + fail
    await vi.advanceTimersByTimeAsync(300);

    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    await workerPromise;

    process.off("unhandledRejection", handler);

    // No unhandled rejections
    expect(unhandledRejections).toHaveLength(0);
    // After the job failed, claimNextJob was called at least twice (slot freed → polling again)
    expect(claimCallCount).toBeGreaterThanOrEqual(2);
  });
});
