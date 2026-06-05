/**
 * @geo/fetch — SSRF-safe POST + submit-time host validator (D-08, D-12)
 *
 * Two exports, both reusing the SAME resolve-then-pin validator as the GET path
 * (validateUrl from safe-fetcher.ts) — the IP classifier + resolver are NOT
 * duplicated here.
 *
 *   1. validateUrlHost(url, opts?) → { ok, code? }
 *      Submit-time check (API POST /audit, D-08). Performs DNS resolution +
 *      IP classification but issues NO HTTP request. (DNS still occurs — this
 *      is "no HTTP request," not "no network.")
 *
 *   2. createSafeRequester(opts?) → (url, { method, body, headers? }) => FetchResult
 *      Fire-time SSRF-safe POST for webhook delivery. Re-resolves+validates on
 *      the call (TOCTOU-safe), POSTs to the PINNED validated IP with TLS
 *      servername set, and never throws.
 *
 * SSRF-POST hardening (D-12), mirroring the Phase-2 GET path:
 *   - redirects DISALLOWED (maxRedirections: 0); a 3xx is returned as an error,
 *     never followed into a private host.
 *   - response-size cap (bounded body read).
 *   - bounded timeout + limited retries with backoff.
 */

import { request, Agent } from "undici";
import type { Dispatcher } from "undici";
import type { FetchResult } from "@geo/core";
import { validateUrl } from "./safe-fetcher.js";
import { FetchErrorCode, buildErrorResult } from "./errors.js";
import type { Resolver } from "./dns-resolve.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SafeRequesterOptions {
  /** Total per-attempt request timeout in milliseconds (default 5_000). */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default 1_000_000). */
  maxBytes?: number;
  /** Number of retries after the first attempt (default 2). */
  retries?: number;
  /** Backoff base in ms between retries (default 250). */
  backoffMs?: number;
  /** Ports allowed in the URL (default [80, 443]). */
  allowedPorts?: number[];
  /** Injectable DNS resolver (tests). Defaults to resolve4+resolve6. */
  resolver?: Resolver;
  /** Injectable undici Dispatcher seam for tests (does NOT skip validation). */
  _testDispatcher?: Dispatcher;
}

export interface SafeRequestInput {
  method: "POST" | "PUT" | "PATCH";
  body?: string;
  headers?: Record<string, string>;
}

const DEFAULT_ALLOWED_PORTS = [80, 443];
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;

// ---------------------------------------------------------------------------
// validateUrlHost — submit-time, no HTTP request (D-08/D-12)
// ---------------------------------------------------------------------------

export interface HostValidationResult {
  ok: boolean;
  code?: FetchErrorCode;
}

/**
 * Resolve + IP-classify a URL's host WITHOUT issuing any HTTP request.
 * Returns { ok: true } if the host's resolved IPs are all public/allowed,
 * else { ok: false, code }. DNS resolution still occurs.
 */
export async function validateUrlHost(
  url: string,
  opts: { allowedPorts?: number[]; resolver?: Resolver } = {},
): Promise<HostValidationResult> {
  const allowedPorts = opts.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const validation = await validateUrl(url, allowedPorts, opts.resolver);
  if (!validation.ok) {
    return { ok: false, code: validation.code };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// createSafeRequester — SSRF-safe POST (D-12)
// ---------------------------------------------------------------------------

export function createSafeRequester(
  options: SafeRequesterOptions = {},
): (url: string, input: SafeRequestInput) => Promise<FetchResult> {
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const resolver = options.resolver;
  const testDispatcher = options._testDispatcher;

  async function attempt(rawUrl: string, input: SafeRequestInput): Promise<FetchResult> {
    // Re-resolve + validate on every attempt (TOCTOU-safe)
    const validation = await validateUrl(rawUrl, allowedPorts, resolver);
    if (!validation.ok) {
      return buildErrorResult(rawUrl, validation.code);
    }

    const { parsedUrl, pinnedIp, hostHeader } = validation;

    const isIpv6 = pinnedIp.includes(":");
    const urlHostWithIp = isIpv6 ? `[${pinnedIp}]` : pinnedIp;
    const pinnedUrl = new URL(rawUrl);
    pinnedUrl.hostname = urlHostWithIp;

    const dispatcher: Dispatcher =
      testDispatcher ??
      new Agent({ connect: { servername: parsedUrl.hostname } });

    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(testDispatcher ? rawUrl : pinnedUrl.toString(), {
        method: input.method,
        headers: {
          host: hostHeader,
          "content-type": "application/json",
          ...(input.headers ?? {}),
        },
        body: input.body,
        dispatcher,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        // undici request() defaults to 0 auto-redirections; a 3xx is returned
        // to us and rejected below (D-12: never follow a redirect into a private host).
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout/i.test(msg) || msg.includes("UND_ERR_HEADERS_TIMEOUT") || msg.includes("UND_ERR_BODY_TIMEOUT")) {
        return buildErrorResult(rawUrl, FetchErrorCode.CONNECT_TIMEOUT);
      }
      return buildErrorResult(rawUrl, FetchErrorCode.FETCH_ERROR);
    }

    const status = response.statusCode;

    // D-12: a 3xx is an SSRF vector — never follow it.
    if (status >= 300 && status <= 399) {
      try { await response.body.dump(); } catch { /* ignore */ }
      return buildErrorResult(rawUrl, FetchErrorCode.REDIRECT_BLOCKED);
    }

    // Lowercase headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    }

    // Content-Length early reject (D-12 size cap)
    const cl = headers["content-length"];
    if (cl !== undefined) {
      const n = parseInt(cl, 10);
      if (!isNaN(n) && n > maxBytes) {
        try { await response.body.dump(); } catch { /* ignore */ }
        return buildErrorResult(rawUrl, FetchErrorCode.RESPONSE_TOO_LARGE);
      }
    }

    // Bounded body read (D-12 size cap for chunked / no content-length)
    let body: string;
    try {
      body = await readBounded(response.body, maxBytes);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === FetchErrorCode.RESPONSE_TOO_LARGE) {
        return buildErrorResult(rawUrl, FetchErrorCode.RESPONSE_TOO_LARGE);
      }
      return buildErrorResult(rawUrl, FetchErrorCode.FETCH_ERROR);
    }

    return { url: rawUrl, status, headers, body, redirectChain: [], error: undefined };
  }

  return async function safeRequest(rawUrl: string, input: SafeRequestInput): Promise<FetchResult> {
    let last: FetchResult = buildErrorResult(rawUrl, FetchErrorCode.FETCH_ERROR);
    for (let i = 0; i <= retries; i++) {
      last = await attempt(rawUrl, input);
      // Do not retry on SSRF/validation blocks — they are deterministic.
      if (last.error === undefined) return last;
      if (
        last.error === FetchErrorCode.SSRF_BLOCKED_IP ||
        last.error === FetchErrorCode.SSRF_BLOCKED_SCHEME ||
        last.error === FetchErrorCode.SSRF_BLOCKED_PORT ||
        last.error === FetchErrorCode.REDIRECT_BLOCKED ||
        last.error === FetchErrorCode.RESPONSE_TOO_LARGE ||
        last.error === FetchErrorCode.DNS_RESOLUTION_FAILED
      ) {
        return last;
      }
      if (i < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
    return last;
  };
}

// ---------------------------------------------------------------------------
// readBounded — buffer the body up to maxBytes, reject if exceeded
// ---------------------------------------------------------------------------

async function readBounded(
  body: { [Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array> },
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error("response too large") as Error & { code: string };
      err.code = FetchErrorCode.RESPONSE_TOO_LARGE;
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
