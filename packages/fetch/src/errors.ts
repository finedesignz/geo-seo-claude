/**
 * @geo/fetch — structured error model (SEC-05)
 *
 * Exactly ten error codes covering all SSRF, DNS, redirect, size, and
 * transport failure modes. buildErrorResult() never throws.
 */

import type { FetchResult } from "@geo/core";

// ---------------------------------------------------------------------------
// Error codes (SEC-05)
// ---------------------------------------------------------------------------

export const FetchErrorCode = {
  SSRF_BLOCKED_IP: "SSRF_BLOCKED_IP",
  SSRF_BLOCKED_SCHEME: "SSRF_BLOCKED_SCHEME",
  SSRF_BLOCKED_PORT: "SSRF_BLOCKED_PORT",
  DNS_RESOLUTION_FAILED: "DNS_RESOLUTION_FAILED",
  REDIRECT_BLOCKED: "REDIRECT_BLOCKED",
  TOO_MANY_REDIRECTS: "TOO_MANY_REDIRECTS",
  RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
  DECOMPRESSION_BOMB: "DECOMPRESSION_BOMB",
  CONNECT_TIMEOUT: "CONNECT_TIMEOUT",
  FETCH_ERROR: "FETCH_ERROR",
} as const;

export type FetchErrorCode = (typeof FetchErrorCode)[keyof typeof FetchErrorCode];

// ---------------------------------------------------------------------------
// Result builder — always returns a valid FetchResult, never throws
// ---------------------------------------------------------------------------

export function buildErrorResult(
  url: string,
  code: FetchErrorCode,
  redirectChain: Array<{ url: string; status: number }> = [],
): FetchResult {
  return {
    url,
    status: 0,
    headers: {},
    body: "",
    redirectChain,
    error: code,
  };
}
