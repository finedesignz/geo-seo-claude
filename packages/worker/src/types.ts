/**
 * @geo/worker — injection-seam contracts (D-16, cross-AI review).
 *
 * WorkerOptions: full constructor options shape consumed by the bin (wave 2)
 * and the worker loop (wave 2). Fields that are not yet wired are present here
 * so later waves can rely on a stable contract without exploring the codebase.
 */

import type { AuditDal, FindingsShape } from "@geo/db";
import type { Fetcher } from "@geo/core";
import type { ScoreResult } from "./scorer.js";

// ---------------------------------------------------------------------------
// Scorer injection seam
// ---------------------------------------------------------------------------

/**
 * The scorer contract consumed by the pipeline. createCliScorer (Claude Code CLI
 * path, cli-scorer.ts) satisfies it; tests inject a fake.
 */
export interface Scorer {
  score(findings: FindingsShape, signal?: AbortSignal): Promise<ScoreResult>;
}

// ---------------------------------------------------------------------------
// Worker constructor options
// ---------------------------------------------------------------------------

/**
 * Full options surface for the worker process (D-16).
 * All numeric fields have defaults in the bin; provide them explicitly in tests.
 *
 * Injectable seams:
 * - dal: AuditDal — inject PGlite-backed dal in tests, postgres.js dal in prod.
 * - scorer: Scorer — CLI scorer in prod, fake in tests.
 * - fetcherFactory: returns a Fetcher per audit run (inject stub in tests).
 * - clock/sleep/setInterval/clearInterval — injectable time primitives so tests
 *   never need real timers (D-16 cross-AI review).
 */
export interface WorkerOptions {
  // ---- business logic ----
  /** Number of jobs to process concurrently. */
  concurrency: number;
  /** How often the worker polls for new jobs (ms). */
  pollIntervalMs: number;
  /** Lease duration granted when claiming a job (seconds). */
  leaseTtlSecs: number;
  /** How often expired leases are reclaimed (ms). */
  reclaimIntervalMs: number;
  /** Max attempts before a job is permanently failed. */
  maxAttempts: number;
  /** Timeout for a single scoring call (ms). */
  scoringTimeoutMs: number;
  /** Grace period during SIGTERM before forceful exit (ms). */
  shutdownGraceMs: number;
  /** Claude model ID to use for scoring. */
  scoringModel: string;

  // ---- injectable DAL + client ----
  dal: AuditDal;
  /** The scorer (CLI in production; tests may inject a fake). */
  scorer: Scorer;

  // ---- injectable fetcher factory ----
  /** Returns a Fetcher for a given audit run. Defaults to @geo/fetch in prod. */
  fetcherFactory: () => Fetcher;

  // ---- injectable time primitives (D-16) ----
  /** Returns current timestamp in ms (defaults to Date.now). */
  now?: () => number;
  /** Resolves after ms milliseconds (defaults to real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Schedules a recurring callback (defaults to real setInterval). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scheduleInterval?: (fn: () => void, ms: number) => any;
  /** Cancels a scheduled interval (defaults to real clearInterval). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cancelInterval?: (handle: any) => void;
}
