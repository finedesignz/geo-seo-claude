/**
 * @geo/worker — pipeline.ts
 *
 * runAudit(job, deps): single-job pipeline.
 *
 * Order: createSafeFetcher → @geo/core checks → FindingsShape → scorer → completeJob.
 * completeJob is called ONLY on the success path (T-04-PARTIAL).
 * Fetch errors (FetchErrorCode) fail the job before any scoring call (T-04-SSRF, D-08).
 * ScoringErrors route to requeueJob (retryable, attempts<MAX) or failJob (terminal).
 * Heartbeat: renewLease every leaseTtlSecs/2; false → abort (T-04-FENCE).
 */

import {
  checkRobots,
  detectRendering,
  computeCitabilityScore,
  validateStructuredData,
  validateLlmsTxt,
} from "@geo/core";
import type { Fetcher } from "@geo/core";
import type { AuditJob, AuditDal, FindingsShape } from "@geo/db";
import { ScoringError } from "./scorer.js";

// ---------------------------------------------------------------------------
// Deps shape for runAudit
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  dal: AuditDal;
  scorer: {
    score(
      findings: FindingsShape,
      signal?: AbortSignal,
    ): Promise<{ score: number; findings: Record<string, unknown> }>;
  };
  fetcher: Fetcher;
  leaseTtlSecs: number;
  maxAttempts: number;
  /** Injectable clock for tests (defaults to real setInterval/clearInterval). */
  clock?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setInterval: (fn: () => void, ms: number) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearInterval: (handle: any) => void;
  };
}

// ---------------------------------------------------------------------------
// runAudit
// ---------------------------------------------------------------------------

export async function runAudit(job: AuditJob, deps: PipelineDeps): Promise<void> {
  const { dal, scorer, fetcher, leaseTtlSecs, maxAttempts } = deps;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setInt: (fn: () => void, ms: number) => any = deps.clock?.setInterval ?? setInterval;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clearInt: (h: any) => void = deps.clock?.clearInterval ?? clearInterval;

  const ac = new AbortController();

  // Heartbeat: renew the lease every TTL/2 ms. False → abort (lease lost).
  const heartbeatMs = Math.floor((leaseTtlSecs * 1000) / 2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const heartbeat: any = setInt(() => {
    void dal.renewLease(job.id, job.leaseToken!, leaseTtlSecs).then((ok) => {
      if (!ok) {
        console.warn(`[pipeline] lease lost for job ${job.id} — aborting`);
        ac.abort();
      }
    });
  }, heartbeatMs);

  try {
    // -----------------------------------------------------------------------
    // Step 1: fetch the page (SSRF-safe)
    // -----------------------------------------------------------------------
    const fetchResult = await fetcher(job.url);

    if (fetchResult.error) {
      // Deterministic fetch error — fail without scoring (D-08, T-04-SSRF)
      if (ac.signal.aborted) return;
      const ok = await dal.failJob(job.id, job.leaseToken!, fetchResult.error);
      if (!ok) console.warn(`[pipeline] failJob lease-loss for job ${job.id}`);
      return;
    }

    // -----------------------------------------------------------------------
    // Step 2: deterministic @geo/core checks
    // -----------------------------------------------------------------------
    const findings: FindingsShape = {};

    // robots.txt — uses fetcher internally (sub-fetch; if blocked → FetchErrorCode in result)
    const robotsResult = await checkRobots(job.url, fetcher);
    findings.robots = robotsResult;

    // Rendering detection from raw HTML
    findings.rendering = detectRendering(fetchResult.body);

    // Citability — needs PageData shape
    findings.citability = computeCitabilityScore({
      html: fetchResult.body,
      url: job.url,
    });

    // Structured data validation
    findings.structuredData = validateStructuredData(fetchResult.body);

    // llms.txt — sub-fetch (reuses safe fetcher)
    const llmsTxtUrl = new URL("/llms.txt", job.url).toString();
    const llmsResult = await fetcher(llmsTxtUrl);
    if (!llmsResult.error && llmsResult.body) {
      findings.llmsTxt = validateLlmsTxt(llmsResult.body);
    }
    // If llms.txt is absent/blocked, leave findings.llmsTxt undefined (LLM scores conservatively)

    // -----------------------------------------------------------------------
    // Step 3: score (Anthropic call)
    // -----------------------------------------------------------------------
    if (ac.signal.aborted) return; // lease lost before scoring

    let scored: { score: number; findings: Record<string, unknown> };
    try {
      scored = await scorer.score(findings, ac.signal);
    } catch (err) {
      if (ac.signal.aborted) return; // lease lost during scoring — no DAL write

      if (err instanceof ScoringError) {
        if (ac.signal.aborted) return;
        // All ScoringErrors are retryable (D-13). Route by attempts vs cap.
        if (job.attempts < maxAttempts) {
          const ok = await dal.requeueJob(job.id, job.leaseToken!, err.code);
          if (!ok) console.warn(`[pipeline] requeueJob lease-loss for job ${job.id}`);
        } else {
          const ok = await dal.failJob(job.id, job.leaseToken!, err.code);
          if (!ok) console.warn(`[pipeline] failJob lease-loss for job ${job.id}`);
        }
        return;
      }

      // Non-ScoringError (unexpected) — fail the job
      if (ac.signal.aborted) return;
      const code = (err as { code?: string }).code ?? "PIPELINE_ERROR";
      const ok = await dal.failJob(job.id, job.leaseToken!, code);
      if (!ok) console.warn(`[pipeline] failJob lease-loss for job ${job.id}`);
      return;
    }

    // -----------------------------------------------------------------------
    // Step 4: persist — success path only (T-04-PARTIAL)
    // -----------------------------------------------------------------------
    if (ac.signal.aborted) return; // lease lost before persisting

    const merged: FindingsShape = {
      ...findings,
      // llmRationale is stored inside findings but FindingsShape is extensible
    };

    const ok = await dal.completeJob(job.id, job.leaseToken!, scored.score, merged);
    if (!ok) console.warn(`[pipeline] completeJob lease-loss for job ${job.id}`);
  } finally {
    clearInt(heartbeat);
  }
}
