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
import { assertEnv } from "./env.js";
import { getDefaultDal } from "@geo/db";
import { createSafeFetcher } from "@geo/fetch";
import { runWorker } from "./worker.js";

// ---------------------------------------------------------------------------
// Fail-fast env check (MUST be first — before any await)
// ---------------------------------------------------------------------------

assertEnv();

// ---------------------------------------------------------------------------
// Env parsing with defaults
// ---------------------------------------------------------------------------

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

const WORKER_CONCURRENCY = envInt("WORKER_CONCURRENCY", 3);
const POLL_INTERVAL_MS = envInt("POLL_INTERVAL_MS", 1000);
const LEASE_TTL_SECONDS = envInt("LEASE_TTL_SECONDS", 120);
const RECLAIM_INTERVAL_MS = envInt("RECLAIM_INTERVAL_MS", Math.floor(LEASE_TTL_SECONDS / 2) * 1000);
const MAX_ATTEMPTS = envInt("MAX_ATTEMPTS", 3);
const SCORING_TIMEOUT_MS = envInt("SCORING_TIMEOUT_MS", 60_000);
const SHUTDOWN_GRACE_MS = envInt("SHUTDOWN_GRACE_MS", 30_000);
const SCORING_MODEL = process.env["SCORING_MODEL"] ?? "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Build production dependencies
// ---------------------------------------------------------------------------

// maxRetries: 0 is MANDATORY — see file header (T-04-RETRY / RESEARCH Pitfall 1)
const anthropic = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"]!,
  maxRetries: 0,
});

const dal = getDefaultDal();

// ---------------------------------------------------------------------------
// Start worker loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await runWorker({
    dal,
    anthropic,
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
