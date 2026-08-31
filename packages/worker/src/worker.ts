/**
 * @geo/worker — worker.ts
 *
 * runWorker(opts: WorkerOptions): long-lived poll loop.
 *
 * - Bounded concurrency: caps in-flight audits at opts.concurrency.
 * - In-flight tracking: Set<Promise<void>> with .catch + .finally for no unhandled rejections.
 * - Heartbeat is owned by runAudit; worker only tracks the promise slot.
 * - Reclaim sweep: setInterval(reclaimExpired, reclaimIntervalMs) — finds crashed jobs.
 * - Graceful shutdown: SIGTERM/SIGINT → stop claiming, drain in-flight, remove handlers, exit.
 * - Injectable clock/sleep seam for deterministic fake-timer tests (D-16).
 */

import { writeFileSync } from "node:fs";
import type { WorkerOptions } from "./types.js";
import { runAudit } from "./pipeline.js";
import { createScorer } from "./scorer.js";

// ---------------------------------------------------------------------------
// runWorker
// ---------------------------------------------------------------------------

export async function runWorker(opts: WorkerOptions): Promise<void> {
  const {
    dal,
    anthropic,
    fetcherFactory,
    concurrency,
    pollIntervalMs,
    leaseTtlSecs,
    reclaimIntervalMs,
    maxAttempts,
    scoringTimeoutMs,
    scoringModel,
    shutdownGraceMs,
  } = opts;

  // Injectable time primitives (fall back to real ones for production)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const scheduleInterval = opts.scheduleInterval ?? setInterval;
  const cancelInterval = opts.cancelInterval ?? clearInterval;

  // Use a pre-built scorer (e.g. the Claude Code CLI scorer) when supplied;
  // otherwise build the API scorer from the injected Anthropic client.
  const scorer =
    opts.scorer ??
    createScorer(anthropic!, { model: scoringModel, timeoutMs: scoringTimeoutMs });

  // In-flight set — each entry is a Promise<void> (already .catch'd)
  const inFlight = new Set<Promise<void>>();

  let shuttingDown = false;

  // Liveness heartbeat (D-06): the worker exposes no HTTP port, so a stale
  // heartbeat file is its health signal (see scripts/worker-healthcheck.sh).
  const heartbeatFile = process.env["WORKER_HEARTBEAT_FILE"] ?? "/tmp/worker-heartbeat";

  // Signal handlers — registered here, removed in finally
  const handleStop = () => {
    shuttingDown = true;
  };

  process.on("SIGTERM", handleStop);
  process.on("SIGINT", handleStop);

  // Reclaim sweep — finds jobs whose leases expired (crashed workers)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reclaimHandle: any = scheduleInterval(() => {
    dal.reclaimExpired(maxAttempts).catch((err) => {
      console.error("[worker] reclaimExpired error:", err);
    });
  }, reclaimIntervalMs);

  try {
    // Poll loop
    while (!shuttingDown) {
      // Refresh liveness heartbeat each iteration (stays fresh even at concurrency
      // cap, since the loop still spins every pollIntervalMs). Non-fatal on IO error.
      try {
        writeFileSync(heartbeatFile, String(Date.now()));
      } catch {
        /* non-fatal — never crash the worker on heartbeat IO error */
      }

      if (inFlight.size < concurrency) {
        let job;
        try {
          job = await dal.claimNextJob(leaseTtlSecs);
        } catch (err) {
          console.error("[worker] claimNextJob error:", err);
          await sleep(pollIntervalMs);
          continue;
        }

        if (job) {
          const fetcher = fetcherFactory();
          const p: Promise<void> = runAudit(job, {
            dal,
            scorer,
            fetcher,
            leaseTtlSecs,
            maxAttempts,
            // Pass the injectable clock through for heartbeat
            clock: opts.scheduleInterval
              ? {
                  setInterval: opts.scheduleInterval as unknown as (fn: () => void, ms: number) => ReturnType<typeof setInterval>,
                  clearInterval: cancelInterval as unknown as (h: ReturnType<typeof setInterval>) => void,
                }
              : undefined,
          })
            .catch((err) => {
              // Prevent unhandled rejections — runAudit should handle its own errors,
              // but defensive catch here protects the process (D-16)
              console.error(`[worker] runAudit unhandled error for job ${job.id}:`, err);
            })
            .finally(() => {
              inFlight.delete(p);
            });

          inFlight.add(p);
        } else {
          // Queue empty — wait before polling again
          await sleep(pollIntervalMs);
        }
      } else {
        // At concurrency cap — wait before checking again
        await sleep(pollIntervalMs);
      }
    }

    // Drain in-flight audits after shutdown signal
    const drainStart = Date.now();
    while (inFlight.size > 0) {
      const elapsed = Date.now() - drainStart;
      if (elapsed >= shutdownGraceMs) {
        console.warn(`[worker] shutdown grace period exceeded (${shutdownGraceMs}ms), abandoning ${inFlight.size} in-flight audits`);
        break;
      }
      await sleep(100);
    }
  } finally {
    cancelInterval(reclaimHandle);
    process.off("SIGTERM", handleStop);
    process.off("SIGINT", handleStop);
  }
}
