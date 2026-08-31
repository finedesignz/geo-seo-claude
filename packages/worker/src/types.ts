/**
 * @geo/worker — injection-seam contracts (D-16, cross-AI review).
 *
 * AnthropicMessagesClient: injectable interface so the Anthropic SDK can be
 * faked in tests without vi.mock. Any object satisfying this interface is valid.
 *
 * WorkerOptions: full constructor options shape consumed by the bin (wave 2)
 * and the worker loop (wave 2). Fields that are not yet wired are present here
 * so later waves can rely on a stable contract without exploring the codebase.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AuditDal, FindingsShape } from "@geo/db";
import type { Fetcher } from "@geo/core";
import type { ScoreResult } from "./scorer.js";

// ---------------------------------------------------------------------------
// Anthropic SDK injection seam
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the Anthropic SDK that @geo/worker calls.
 * Inject a real `new Anthropic()` instance in production; inject a fake in tests.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
  };
}

// ---------------------------------------------------------------------------
// Scorer injection seam
// ---------------------------------------------------------------------------

/**
 * The scorer contract consumed by the pipeline. Both createScorer (API path,
 * scorer.ts) and createCliScorer (Claude Code CLI path, cli-scorer.ts) satisfy
 * it, so the worker loop can be wired with either behind a provider switch.
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
 * - anthropic: AnthropicMessagesClient — inject fake in tests, real SDK in prod.
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
  /** Timeout for a single Anthropic scoring call (ms). */
  scoringTimeoutMs: number;
  /** Grace period during SIGTERM before forceful exit (ms). */
  shutdownGraceMs: number;
  /** Anthropic model ID to use for scoring. */
  scoringModel: string;

  // ---- injectable DAL + client ----
  dal: AuditDal;
  /**
   * Anthropic Messages client for the API scoring path. Optional: when a
   * pre-built `scorer` is supplied (e.g. the CLI scorer), this is unused.
   */
  anthropic?: AnthropicMessagesClient;
  /**
   * Pre-built scorer. When provided, the worker uses it directly instead of
   * constructing the API scorer from `anthropic`. Set by the provider switch in
   * main.ts (CLI vs API); tests may inject a fake.
   */
  scorer?: Scorer;

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
