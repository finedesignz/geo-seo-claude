/**
 * @geo/worker — bin entry point.
 *
 * Wires all production dependencies and starts the worker loop.
 * assertEnv() is called FIRST — fail-fast before any async initialization (T-04-INFO).
 */

import { assertEnv } from "./env.js";
import { getDefaultDal } from "@geo/db";
import { createSafeFetcher } from "@geo/fetch";
import { runWorker } from "./worker.js";
import { createCliScorer } from "./cli-scorer.js";
import { loadWorkerTunables } from "./config.js";

// ---------------------------------------------------------------------------
// Fail-fast env check (MUST be first — before any await)
// ---------------------------------------------------------------------------

assertEnv();

// ---------------------------------------------------------------------------
// Env parsing with defaults (pure logic lives in config.ts — unit tested there)
// ---------------------------------------------------------------------------

const {
  workerConcurrency: WORKER_CONCURRENCY,
  pollIntervalMs: POLL_INTERVAL_MS,
  leaseTtlSeconds: LEASE_TTL_SECONDS,
  reclaimIntervalMs: RECLAIM_INTERVAL_MS,
  maxAttempts: MAX_ATTEMPTS,
  scoringTimeoutMs: SCORING_TIMEOUT_MS,
  shutdownGraceMs: SHUTDOWN_GRACE_MS,
  scoringModel: SCORING_MODEL,
} = loadWorkerTunables();

// ---------------------------------------------------------------------------
// Build production dependencies
// ---------------------------------------------------------------------------

// The scorer spawns the logged-in `claude` binary (subscription OAuth); no API client.
const scorer = createCliScorer({
  model: SCORING_MODEL,
  timeoutMs: SCORING_TIMEOUT_MS,
  claudeBin: process.env["CLAUDE_BIN"],
});

const dal = getDefaultDal();

// ---------------------------------------------------------------------------
// Start worker loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await runWorker({
    dal,
    scorer,
    fetcherFactory: () => createSafeFetcher(),
    concurrency: WORKER_CONCURRENCY,
    pollIntervalMs: POLL_INTERVAL_MS,
    leaseTtlSecs: LEASE_TTL_SECONDS,
    reclaimIntervalMs: RECLAIM_INTERVAL_MS,
    maxAttempts: MAX_ATTEMPTS,
    scoringTimeoutMs: SCORING_TIMEOUT_MS,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    scoringModel: SCORING_MODEL,
  });
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
