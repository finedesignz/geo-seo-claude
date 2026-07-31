/**
 * @geo/worker — config.ts
 *
 * Pure env-var parsing for worker tunables, extracted from main.ts so the
 * parsing logic (including defaults) is unit-testable without triggering
 * main.ts's side effects (assertEnv, client construction, runWorker start —
 * main.ts is a bin entry point, not an importable module for tests).
 */

export function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

export interface WorkerTunables {
  workerConcurrency: number;
  pollIntervalMs: number;
  leaseTtlSeconds: number;
  reclaimIntervalMs: number;
  maxAttempts: number;
  scoringTimeoutMs: number;
  shutdownGraceMs: number;
  scoringModel: string;
}

/**
 * SCORING_TIMEOUT_MS default — raised from 60_000 to 180_000 (3 min) on
 * production evidence, not a guess (VERIFICATION-scoring-fix.md, 2026-07-31):
 * a real audit of en.wikipedia.org/wiki/Web_scraping (5042 words) timed out
 * at 60s on attempt 1 and only completed on attempt 2; a second audit against
 * anthropic.com exhausted all 3 retry attempts, each hitting the 60s ceiling,
 * and never produced a score. The `claude` CLI is a full subprocess (session
 * init/auth handshake + model inference), not a lean API call, so 60s proved
 * insufficient for realistic pages on repeat trials, not just an unlucky
 * tail. 180_000 gives 3x headroom over the value that failed repeatedly in
 * production while staying bounded — worst case with MAX_ATTEMPTS=3 is 9
 * minutes before a job fails terminal, not unbounded.
 */
export const DEFAULT_SCORING_TIMEOUT_MS = 180_000;

/** Reads every worker tunable from process.env, applying the PATTERNS defaults. */
export function loadWorkerTunables(): WorkerTunables {
  const leaseTtlSeconds = envInt("LEASE_TTL_SECONDS", 120);
  return {
    workerConcurrency: envInt("WORKER_CONCURRENCY", 3),
    pollIntervalMs: envInt("POLL_INTERVAL_MS", 1000),
    leaseTtlSeconds,
    reclaimIntervalMs: envInt("RECLAIM_INTERVAL_MS", Math.floor(leaseTtlSeconds / 2) * 1000),
    maxAttempts: envInt("MAX_ATTEMPTS", 3),
    scoringTimeoutMs: envInt("SCORING_TIMEOUT_MS", DEFAULT_SCORING_TIMEOUT_MS),
    shutdownGraceMs: envInt("SHUTDOWN_GRACE_MS", 30_000),
    scoringModel: process.env["SCORING_MODEL"] ?? "claude-sonnet-4-6",
  };
}
