/**
 * @geo/worker — bin entry point.
 *
 * Wires all production dependencies and starts the worker loop.
 * assertEnv() is called FIRST — fail-fast before any async initialization (T-04-INFO).
 *
 * IMPORTANT (RESEARCH Pitfall 1 / T-04-RETRY):
 * The Anthropic client is constructed with `maxRetries: 0` — the only place the
 * real client is built. The SDK's default maxRetries:2 would auto-retry 429/5xx
 * inside the SDK, masking the error type and mis-classifying the retry disposition.
 * The lease/attempts mechanism owns retries; the SDK must not silently absorb them.
 */

import Anthropic from "@anthropic-ai/sdk";
import { assertEnv, resolveScoringProvider } from "./env.js";
import { getDefaultDal } from "@geo/db";
import { createSafeFetcher } from "@geo/fetch";
import { runWorker } from "./worker.js";
import { createCliScorer } from "./cli-scorer.js";
import { loadWorkerTunables } from "./config.js";
import type { Scorer } from "./types.js";

// ---------------------------------------------------------------------------
// Fail-fast env check (MUST be first — before any await)
// ---------------------------------------------------------------------------

// "api"  → Anthropic Messages API + ANTHROPIC_API_KEY
// "cli"  → Claude Code CLI (subscription) via CLAUDE_CODE_OAUTH_TOKEN / login
const SCORING_PROVIDER = resolveScoringProvider();
assertEnv(SCORING_PROVIDER);

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

// Build the scorer for the selected provider.
// - CLI: spawn the logged-in `claude` binary (subscription); no API client.
// - API: Anthropic Messages client with maxRetries:0 (MANDATORY — see file
//   header, T-04-RETRY / RESEARCH Pitfall 1).
let scorer: Scorer | undefined;
let anthropic: Anthropic | undefined;

if (SCORING_PROVIDER === "cli") {
  scorer = createCliScorer({
    model: SCORING_MODEL,
    timeoutMs: SCORING_TIMEOUT_MS,
    claudeBin: process.env["CLAUDE_BIN"],
  });
} else {
  anthropic = new Anthropic({
    apiKey: process.env["ANTHROPIC_API_KEY"]!,
    maxRetries: 0,
  });
}

const dal = getDefaultDal();

// ---------------------------------------------------------------------------
// Start worker loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await runWorker({
    dal,
    anthropic,
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
