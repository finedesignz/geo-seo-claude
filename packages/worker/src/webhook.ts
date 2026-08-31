/**
 * @geo/worker — webhook.ts (API-08 fire half, D-08 / D-12).
 *
 * deliverWebhook POSTs the audit outcome to a consumer's callback_url via the
 * SSRF-safe @geo/fetch createSafeRequester. Fire-time hardening (D-12), all
 * provided by createSafeRequester:
 *   - host re-resolved + IP-classified on EVERY attempt (TOCTOU-safe) — a URL
 *     that resolves to a private IP at fire time is blocked, never connected.
 *   - redirects DISALLOWED (a 3xx → REDIRECT_BLOCKED, never followed into a
 *     private host).
 *   - response-size cap + bounded timeout (5s) + limited retries with backoff.
 *
 * Delivery is NON-FATAL: every failure (timeout, non-2xx-as-error, SSRF block)
 * is logged and swallowed. deliverWebhook NEVER throws and never affects job
 * state. The requester is injectable so tests drive a mock without network.
 */

import { createSafeRequester } from "@geo/fetch";
import type { FetchResult } from "@geo/core";

/** Injectable requester seam (defaults to the real SSRF-safe POST). */
export type WebhookRequester = (
  url: string,
  input: { method: "POST"; body?: string; headers?: Record<string, string> },
) => Promise<FetchResult>;

export interface WebhookPayload {
  job_id: string;
  status: string;
  score: number | null;
  findings: unknown;
}

export interface DeliverWebhookDeps {
  /** Inject a requester for tests; production uses a hardened createSafeRequester. */
  requester?: WebhookRequester;
  /** Retries AFTER the first attempt (default 2). */
  maxRetries?: number;
  /** Per-attempt timeout (default 5000ms). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;
/** Webhook response bodies are ignored; cap small to bound DoS surface (D-12). */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Deliver a webhook for a finished audit. Always resolves (non-fatal). On a
 * successful (non-error) POST it returns immediately; otherwise it logs and,
 * for transient errors, retries up to maxRetries. createSafeRequester does NOT
 * retry deterministic SSRF/redirect/size blocks, so a private-resolving host
 * fails fast without burning retries.
 */
export async function deliverWebhook(
  callbackUrl: string,
  payload: WebhookPayload,
  deps: DeliverWebhookDeps = {},
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  // createSafeRequester already re-validates per attempt and retries transient
  // errors internally; we add an OUTER loop only as a defensive belt so a single
  // top-level error result is still re-attempted if a custom requester does not.
  const requester: WebhookRequester =
    deps.requester ??
    createSafeRequester({
      timeoutMs,
      retries: maxRetries,
      maxBytes: MAX_RESPONSE_BYTES,
    });

  const body = JSON.stringify(payload);

  let last: FetchResult | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      last = await requester(callbackUrl, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      // A requester should never throw, but stay non-fatal regardless.
      console.warn(`[webhook] delivery threw for job ${payload.job_id}:`, err);
      return;
    }

    if (!last.error) return; // delivered

    console.warn(
      `[webhook] delivery attempt ${attempt + 1} failed for job ${payload.job_id}: ${last.error}`,
    );

    // Deterministic blocks must not be retried at this layer either.
    if (isDeterministicBlock(last.error)) return;
  }
  // Exhausted — already logged; non-fatal.
}

/** True for errors that re-attempting cannot fix (SSRF/redirect/size/scheme/port). */
function isDeterministicBlock(code: string): boolean {
  return (
    code === "SSRF_BLOCKED_IP" ||
    code === "SSRF_BLOCKED_SCHEME" ||
    code === "SSRF_BLOCKED_PORT" ||
    code === "REDIRECT_BLOCKED" ||
    code === "RESPONSE_TOO_LARGE" ||
    code === "DNS_RESOLUTION_FAILED"
  );
}
