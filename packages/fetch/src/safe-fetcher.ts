/**
 * @geo/fetch — createSafeFetcher (SEC-01, SEC-02, SEC-03, SEC-05)
 *
 * Returns a Fetcher (url: string) => Promise<FetchResult> that:
 *   1. Parses the URL; rejects userinfo, non-http/https schemes, disallowed ports.
 *   2. Resolves ALL A+AAAA records and denies any blocked IP (SEC-01).
 *   3. Connects via undici to the PINNED validated IP with Host and TLS servername
 *      set to the original hostname — resolve-then-pin, NO second DNS lookup (SEC-02).
 *   4. Follows redirects MANUALLY (redirect: 'manual'), re-running full SSRF validation
 *      on EACH hop's Location target before connecting (SEC-03).
 *      - Relative Location headers resolved against current URL before re-validation.
 *      - Exceeding maxRedirects → TOO_MANY_REDIRECTS.
 *      - Blocked hop target → REDIRECT_BLOCKED (chain carried).
 *   5. Returns FetchResult with lowercased headers; never throws (SEC-05).
 *
 * Uses undici's `request` (NOT Bun's global fetch) to support custom connect
 * options for IP pinning. (Bun issue #27890 breaks HTTPS with custom lookup.)
 */

import { request, Agent } from "undici";
import type { Dispatcher } from "undici";
import { Readable } from "node:stream";
import { Gunzip, Inflate } from "node:zlib";
import type { FetchResult } from "@geo/core";
import { resolveAndValidate, DnsValidationError } from "./dns-resolve.js";
import { FetchErrorCode, buildErrorResult } from "./errors.js";
import { makeByteCounter, buildDecompressChain, sniffEncoding } from "./decompression.js";
import type { Resolver } from "./dns-resolve.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SafeFetcherOptions {
  /** Maximum response body size in bytes (default 5_000_000). Wave 3. */
  maxBytes?: number;
  /** Maximum redirects to follow (default 5). Wave 2. */
  maxRedirects?: number;
  /** Total request timeout in milliseconds (default 10_000). */
  timeoutMs?: number;
  /** Ports allowed in the URL (default [80, 443]). */
  allowedPorts?: number[];
  /**
   * Injectable DNS resolver (hostname) → string[].
   * Defaults to node:dns/promises resolve4+resolve6.
   * Tests inject a mock resolver to avoid real DNS and control IP lists.
   */
  resolver?: Resolver;
  /**
   * Injectable undici Dispatcher seam for tests.
   *
   * Production: omit — undici connects normally to the pinned IP.
   * Tests: provide a MockAgent/Pool that routes a "public-looking" hostname
   * to the loopback test server without disabling the IP deny-list.
   *
   * This seam DOES NOT skip IP validation. resolveAndValidate still runs.
   * It only replaces the network transport layer AFTER validation passes.
   */
  _testDispatcher?: Dispatcher;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_PORTS = [80, 443];
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the effective port for a URL (uses scheme default when omitted).
 */
function effectivePort(url: URL): number {
  if (url.port !== "") {
    return parseInt(url.port, 10);
  }
  return url.protocol === "https:" ? 443 : 80;
}

// ---------------------------------------------------------------------------
// Internal: validate a single URL and build a pinned request target
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: true;
  parsedUrl: URL;
  pinnedIp: string;
  hostHeader: string;
}

export interface ValidationError {
  ok: false;
  code: FetchErrorCode;
}

/**
 * Validate a raw URL and return a pinned-IP request target (resolve-then-pin).
 * Exported so the SSRF-safe POST path (safe-requester.ts) reuses the SAME
 * scheme/port/userinfo/DNS+IP-classification validator — no duplication.
 */
export async function validateUrl(
  rawUrl: string,
  allowedPorts: number[],
  resolver: Resolver | undefined,
): Promise<ValidationResult | ValidationError> {
  // Parse URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { ok: false, code: FetchErrorCode.SSRF_BLOCKED_SCHEME };
  }

  // Deny userinfo (Pitfall 7 — userinfo@host trick)
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return { ok: false, code: FetchErrorCode.SSRF_BLOCKED_SCHEME };
  }

  // Scheme allowlist: http/https only
  if (!ALLOWED_SCHEMES.has(parsedUrl.protocol)) {
    return { ok: false, code: FetchErrorCode.SSRF_BLOCKED_SCHEME };
  }

  // Port allowlist
  const port = effectivePort(parsedUrl);
  if (!allowedPorts.includes(port)) {
    return { ok: false, code: FetchErrorCode.SSRF_BLOCKED_PORT };
  }

  const originalHostname = parsedUrl.hostname;
  const isIpLit = isDirectIpLiteral(originalHostname);

  let pinnedIp: string;

  if (isIpLit) {
    const { isBlockedIP } = await import("./ip-validator.js");
    const rawIp = originalHostname.startsWith("[")
      ? originalHostname.slice(1, -1)
      : originalHostname;

    if (isBlockedIP(rawIp)) {
      return { ok: false, code: FetchErrorCode.SSRF_BLOCKED_IP };
    }
    pinnedIp = rawIp;
  } else {
    let validatedIps: string[];
    try {
      validatedIps = await resolveAndValidate(originalHostname, resolver);
    } catch (err) {
      if (err instanceof DnsValidationError) {
        return { ok: false, code: err.code };
      }
      return { ok: false, code: FetchErrorCode.DNS_RESOLUTION_FAILED };
    }
    const firstIp = validatedIps[0];
    if (firstIp === undefined) {
      return { ok: false, code: FetchErrorCode.DNS_RESOLUTION_FAILED };
    }
    pinnedIp = firstIp;
  }

  const originalPort = parsedUrl.port;
  const hostHeader =
    originalPort !== "" ? `${originalHostname}:${originalPort}` : originalHostname;

  return { ok: true, parsedUrl, pinnedIp, hostHeader };
}

// ---------------------------------------------------------------------------
// createSafeFetcher
// ---------------------------------------------------------------------------

/**
 * Factory that returns a hardened Fetcher conforming to @geo/core Fetcher.
 */
export function createSafeFetcher(options: SafeFetcherOptions = {}): (url: string) => Promise<FetchResult> {
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? 5_000_000;
  const resolver = options.resolver;
  const testDispatcher = options._testDispatcher;

  return async function safeFetch(rawUrl: string): Promise<FetchResult> {
    const redirectChain: Array<{ url: string; status: number }> = [];
    let currentUrl = rawUrl;

    // -------------------------------------------------------------------------
    // Manual redirect loop (SEC-03)
    // Each iteration validates the current hop URL before connecting.
    // -------------------------------------------------------------------------
    for (;;) {
      // -----------------------------------------------------------------------
      // Validate current hop URL (full SSRF validation per hop)
      // -----------------------------------------------------------------------
      const validation = await validateUrl(currentUrl, allowedPorts, resolver);

      if (!validation.ok) {
        // If we are past the first hop, this is a redirect-blocked event
        if (redirectChain.length > 0) {
          return buildErrorResult(rawUrl, FetchErrorCode.REDIRECT_BLOCKED, redirectChain);
        }
        return buildErrorResult(rawUrl, validation.code);
      }

      const { parsedUrl, pinnedIp, hostHeader } = validation;

      // -----------------------------------------------------------------------
      // Build pinned request URL
      // -----------------------------------------------------------------------
      const isIpv6 = pinnedIp.includes(":");
      const urlHostWithIp = isIpv6 ? `[${pinnedIp}]` : pinnedIp;

      const pinnedUrl = new URL(currentUrl);
      pinnedUrl.hostname = urlHostWithIp;

      // -----------------------------------------------------------------------
      // Build dispatcher
      // -----------------------------------------------------------------------
      let dispatcher: Dispatcher | undefined;

      if (testDispatcher) {
        dispatcher = testDispatcher;
      } else {
        dispatcher = new Agent({
          connect: {
            servername: parsedUrl.hostname,
          },
        });
      }

      // -----------------------------------------------------------------------
      // Execute pinned undici request — redirect: 'manual' stops auto-follow
      // -----------------------------------------------------------------------
      let response: Awaited<ReturnType<typeof request>>;
      try {
        response = await request(
          testDispatcher ? currentUrl : pinnedUrl.toString(),
          {
            method: "GET",
            headers: {
              host: hostHeader,
              // Request gzip/deflate ONLY — never brotli. Bun's node:zlib brotli
              // decoder (baseline build) throws ERR_BROTLI_DECODER_ERROR_FORMAT_RESERVED
              // on streams Node decodes fine; excluding `br` avoids it entirely while
              // still letting origins compress. A misbehaving origin that sends `br`
              // anyway is handled gracefully (decoder errors → FETCH_ERROR, never a
              // process crash — see readBodyBounded).
              "accept-encoding": "gzip, deflate",
            },
            dispatcher,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            // undici request() default is 0 auto-redirections; no option needed (SEC-03)
          },
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (
          errMsg.includes("timeout") ||
          errMsg.includes("Timeout") ||
          errMsg.includes("UND_ERR_HEADERS_TIMEOUT") ||
          errMsg.includes("UND_ERR_BODY_TIMEOUT")
        ) {
          return buildErrorResult(rawUrl, FetchErrorCode.CONNECT_TIMEOUT, redirectChain);
        }
        return buildErrorResult(rawUrl, FetchErrorCode.FETCH_ERROR, redirectChain);
      }

      const status = response.statusCode;

      // -----------------------------------------------------------------------
      // Handle 3xx redirects
      // -----------------------------------------------------------------------
      if (status >= 300 && status <= 399) {
        // Record this hop
        redirectChain.push({ url: currentUrl, status });

        // Enforce redirect cap BEFORE attempting the next hop
        if (redirectChain.length >= maxRedirects) {
          // Drain body to avoid connection leak
          try { await response.body.dump(); } catch { /* ignore */ }
          return buildErrorResult(rawUrl, FetchErrorCode.TOO_MANY_REDIRECTS, redirectChain);
        }

        // Extract Location header
        const location = response.headers["location"];
        const locationStr = Array.isArray(location) ? location[0] : location;

        if (!locationStr) {
          // 3xx with no Location — treat as fetch error
          try { await response.body.dump(); } catch { /* ignore */ }
          return buildErrorResult(rawUrl, FetchErrorCode.FETCH_ERROR, redirectChain);
        }

        // Drain body before following redirect
        try { await response.body.dump(); } catch { /* ignore */ }

        // Resolve relative Location against current URL (SEC-03 anti-pattern fix)
        try {
          currentUrl = new URL(locationStr, currentUrl).href;
        } catch {
          return buildErrorResult(rawUrl, FetchErrorCode.FETCH_ERROR, redirectChain);
        }

        // Loop: re-validate next hop
        continue;
      }

      // -----------------------------------------------------------------------
      // Non-redirect response — build FetchResult
      // -----------------------------------------------------------------------
      const headers: Record<string, string> = {};
      const rawHeaders = response.headers;

      if (rawHeaders) {
        for (const [key, value] of Object.entries(rawHeaders)) {
          if (value !== undefined) {
            headers[key.toLowerCase()] = Array.isArray(value)
              ? value.join(", ")
              : String(value);
          }
        }
      }

      // -----------------------------------------------------------------------
      // Content-Length early reject (SEC-04)
      // -----------------------------------------------------------------------
      const contentLengthHeader = headers["content-length"];
      if (contentLengthHeader !== undefined) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
          try { await response.body.dump(); } catch { /* ignore */ }
          return buildErrorResult(rawUrl, FetchErrorCode.RESPONSE_TOO_LARGE, redirectChain);
        }
      }

      // -----------------------------------------------------------------------
      // Build decompression pipeline; throws synchronously for stacked>2 or unknown
      // -----------------------------------------------------------------------
      let decompressChain: NodeJS.ReadWriteStream[];
      try {
        decompressChain = buildDecompressChain(headers["content-encoding"] ?? null, maxBytes);
      } catch (err) {
        const code = (err as { code?: string }).code;
        try { await response.body.dump(); } catch { /* ignore */ }
        return buildErrorResult(
          rawUrl,
          code === FetchErrorCode.DECOMPRESSION_BOMB
            ? FetchErrorCode.DECOMPRESSION_BOMB
            : FetchErrorCode.FETCH_ERROR,
          redirectChain,
        );
      }

      // -----------------------------------------------------------------------
      // Stream body through decompress chain + identity size counter (SEC-04)
      // If no decompressors, still apply a raw-byte counter for RESPONSE_TOO_LARGE.
      // -----------------------------------------------------------------------
      let body: string;
      try {
        body = await readBodyBounded(response.body, decompressChain, maxBytes);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === FetchErrorCode.RESPONSE_TOO_LARGE) {
          return buildErrorResult(rawUrl, FetchErrorCode.RESPONSE_TOO_LARGE, redirectChain);
        }
        if (code === FetchErrorCode.DECOMPRESSION_BOMB) {
          return buildErrorResult(rawUrl, FetchErrorCode.DECOMPRESSION_BOMB, redirectChain);
        }
        return buildErrorResult(rawUrl, FetchErrorCode.FETCH_ERROR, redirectChain);
      }

      return {
        url: rawUrl,
        status,
        headers,
        body,
        redirectChain,
        error: undefined,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// readBodyBounded — stream body through decompression + byte cap
// ---------------------------------------------------------------------------

/**
 * Reads the response body through an optional decompression chain and a
 * raw-wire byte counter. Returns the buffered UTF-8 string.
 *
 * If `decompressChain` is empty, applies only a raw-byte counter
 * (RESPONSE_TOO_LARGE) so identity bodies are capped too.
 *
 * Rejects with an error carrying `.code = RESPONSE_TOO_LARGE | DECOMPRESSION_BOMB`
 * if either cap is exceeded.
 *
 * Decide-then-pipe, never catch-then-guess: before installing a decompressor,
 * the actual first wire bytes are sniffed (sniffEncoding). Bun's undici
 * `request()` transparently decompresses gzip/deflate bodies over real sockets
 * while still reporting the original Content-Encoding header, so a gzip/deflate
 * decompressor fed already-plaintext bytes would otherwise throw Z_DATA_ERROR
 * ("incorrect header check") on the first stage. Only Gunzip/Inflate stages are
 * sniffable this way (gzip/deflate have fixed magic numbers); brotli has none,
 * so a declared `br` encoding is always piped through its real decompressor and
 * genuinely bad bytes still reject — this never masks real corruption as valid.
 */
export async function readBodyBounded(
  body: { [Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array> },
  decompressChain: NodeJS.ReadWriteStream[],
  maxBytes: number,
): Promise<string> {
  const hasDecompressor = decompressChain.length > 0;

  // Peek the first chunk off the raw wire stream, then replay it ahead of the
  // rest of the iterator so no bytes are lost.
  const iterator = body[Symbol.asyncIterator]();
  const firstResult = await iterator.next();
  const firstChunk = firstResult.done
    ? undefined
    : Buffer.isBuffer(firstResult.value)
      ? firstResult.value
      : Buffer.from(firstResult.value);

  async function* replay(): AsyncGenerator<Buffer> {
    if (firstChunk) yield firstChunk;
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) return;
      yield Buffer.isBuffer(value) ? value : Buffer.from(value);
    }
  }

  const firstStage = decompressChain[0];
  const firstStageIsSniffable = firstStage instanceof Gunzip || firstStage instanceof Inflate;
  const bodyAlreadyPlaintext =
    hasDecompressor &&
    firstStageIsSniffable &&
    firstChunk !== undefined &&
    sniffEncoding(firstChunk) === null;

  const stages: NodeJS.ReadWriteStream[] =
    hasDecompressor && !bodyAlreadyPlaintext
      ? decompressChain
      : [makeByteCounter(maxBytes, FetchErrorCode.RESPONSE_TOO_LARGE)];

  const source = Readable.from(replay());
  const last = stages[stages.length - 1]!;
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      // Tear down the source so the undici socket is released on any stage error.
      source.destroy();
      reject(err);
    };

    last.on("data", (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    last.on("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    // Attach an error handler to EVERY stage — .pipe() does not forward errors,
    // so a middle decompressor (e.g. brotli) erroring would otherwise be an
    // unhandled 'error' event that crashes the process.
    source.on("error", fail);
    stages.forEach((stage) => stage.on("error", fail));

    let current: NodeJS.ReadableStream = source;
    for (const stage of stages) {
      current = current.pipe(stage as unknown as NodeJS.WritableStream & NodeJS.ReadableStream);
    }
  });

  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// IP literal detection helper
// ---------------------------------------------------------------------------

/**
 * Returns true if the hostname is an IPv4 or IPv6 literal (not a DNS name).
 * IPv6 literals in URLs are bracketed: [::1]
 */
function isDirectIpLiteral(hostname: string): boolean {
  // IPv6 literals are wrapped in brackets by the URL parser
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return true;
  }
  // IPv4: all segments are numeric
  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    return true;
  }
  // Obfuscated forms (octal, hex, decimal integer) — isBlockedIP handles these,
  // but we need to detect them as literals to skip DNS. Check if ipaddr.js can parse.
  // A simple heuristic: if hostname matches pure-numeric or 0x/0 prefix patterns.
  if (/^(0x[0-9a-fA-F]+|0[0-7]+|\d+)$/.test(hostname)) {
    return true;
  }
  return false;
}
