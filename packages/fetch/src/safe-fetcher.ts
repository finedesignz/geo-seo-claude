/**
 * @geo/fetch — createSafeFetcher (SEC-01, SEC-02, SEC-05)
 *
 * Returns a Fetcher (url: string) => Promise<FetchResult> that:
 *   1. Parses the URL; rejects userinfo, non-http/https schemes, disallowed ports.
 *   2. Resolves ALL A+AAAA records and denies any blocked IP (SEC-01).
 *   3. Connects via undici to the PINNED validated IP with Host and TLS servername
 *      set to the original hostname — resolve-then-pin, NO second DNS lookup (SEC-02).
 *   4. Returns FetchResult with lowercased headers; never throws (SEC-05).
 *
 * Uses undici's `request` (NOT Bun's global fetch) to support custom connect
 * options for IP pinning. (Bun issue #27890 breaks HTTPS with custom lookup.)
 */

import { request, Agent } from "undici";
import type { Dispatcher } from "undici";
import type { FetchResult } from "@geo/core";
import { resolveAndValidate, DnsValidationError } from "./dns-resolve.js";
import { FetchErrorCode, buildErrorResult } from "./errors.js";
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
// createSafeFetcher
// ---------------------------------------------------------------------------

/**
 * Factory that returns a hardened Fetcher conforming to @geo/core Fetcher.
 */
export function createSafeFetcher(options: SafeFetcherOptions = {}): (url: string) => Promise<FetchResult> {
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolver = options.resolver;
  const testDispatcher = options._testDispatcher;

  return async function safeFetch(rawUrl: string): Promise<FetchResult> {
    // -------------------------------------------------------------------------
    // 1. Parse URL
    // -------------------------------------------------------------------------
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return buildErrorResult(rawUrl, FetchErrorCode.SSRF_BLOCKED_SCHEME);
    }

    // -------------------------------------------------------------------------
    // 2. Deny userinfo (Pitfall 7 — userinfo@host trick)
    // -------------------------------------------------------------------------
    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      return buildErrorResult(rawUrl, FetchErrorCode.SSRF_BLOCKED_SCHEME);
    }

    // -------------------------------------------------------------------------
    // 3. Scheme allowlist: http/https only
    // -------------------------------------------------------------------------
    if (!ALLOWED_SCHEMES.has(parsedUrl.protocol)) {
      return buildErrorResult(rawUrl, FetchErrorCode.SSRF_BLOCKED_SCHEME);
    }

    // -------------------------------------------------------------------------
    // 4. Port allowlist
    // -------------------------------------------------------------------------
    const port = effectivePort(parsedUrl);
    if (!allowedPorts.includes(port)) {
      return buildErrorResult(rawUrl, FetchErrorCode.SSRF_BLOCKED_PORT);
    }

    // -------------------------------------------------------------------------
    // 5. Resolve-then-validate (SEC-01, SEC-02)
    //    The hostname might be an IP literal — handle both cases.
    // -------------------------------------------------------------------------
    const originalHostname = parsedUrl.hostname;

    // Check if the hostname is already an IP literal
    // (isBlockedIP returns true for private IPs — we also use it here to detect literals)
    const isIpLiteral = isDirectIpLiteral(originalHostname);

    let pinnedIp: string;

    if (isIpLiteral) {
      // IP literal: skip DNS, validate directly
      const { isBlockedIP } = await import("./ip-validator.js");
      // Strip brackets from IPv6 literals
      const rawIp = originalHostname.startsWith("[")
        ? originalHostname.slice(1, -1)
        : originalHostname;

      if (isBlockedIP(rawIp)) {
        return buildErrorResult(rawUrl, FetchErrorCode.SSRF_BLOCKED_IP);
      }
      pinnedIp = rawIp;
    } else {
      // Hostname: resolve ALL A+AAAA records and validate
      let validatedIps: string[];
      try {
        validatedIps = await resolveAndValidate(originalHostname, resolver);
      } catch (err) {
        if (err instanceof DnsValidationError) {
          return buildErrorResult(rawUrl, err.code);
        }
        return buildErrorResult(rawUrl, FetchErrorCode.DNS_RESOLUTION_FAILED);
      }
      // Pin to the first validated IP (connection will use this exact IP).
      // validatedIps is guaranteed non-empty by resolveAndValidate.
      const firstIp = validatedIps[0];
      if (firstIp === undefined) {
        return buildErrorResult(rawUrl, FetchErrorCode.DNS_RESOLUTION_FAILED);
      }
      pinnedIp = firstIp;
    }

    // -------------------------------------------------------------------------
    // 6. Build pinned request URL
    //    Replace hostname with pinned IP; set Host header to original host.
    //    For IPv6, bracket the address in the URL.
    // -------------------------------------------------------------------------
    const isIpv6 = pinnedIp.includes(":");
    const urlHostWithIp = isIpv6 ? `[${pinnedIp}]` : pinnedIp;

    // Reconstruct URL pointing to the pinned IP
    const pinnedUrl = new URL(rawUrl);
    pinnedUrl.hostname = urlHostWithIp;

    // Original host:port for the Host header (omit default ports)
    const originalPort = parsedUrl.port;
    const hostHeader =
      originalPort !== "" ? `${originalHostname}:${originalPort}` : originalHostname;

    // -------------------------------------------------------------------------
    // 7. Execute pinned undici request (resolve-then-pin — NO second DNS lookup)
    //    connect.servername preserves TLS SNI against the original hostname.
    //    connect.rejectUnauthorized stays true (default) — never bypass certs.
    // -------------------------------------------------------------------------
    let dispatcher: Dispatcher | undefined;

    if (testDispatcher) {
      // Test seam: provided dispatcher routes the request to the test server.
      // IP validation has ALREADY run above — the seam is post-validation only.
      dispatcher = testDispatcher;
    } else {
      // Production: create an Agent that connects to the pinned IP with correct SNI.
      dispatcher = new Agent({
        connect: {
          // Preserve TLS SNI to match the certificate (T-02-09)
          servername: originalHostname,
          // rejectUnauthorized defaults to true — do not disable
        },
      });
    }

    try {
      const response = await request(
        testDispatcher ? rawUrl : pinnedUrl.toString(),
        {
          method: "GET",
          headers: {
            host: hostHeader,
          },
          dispatcher,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          // Wave 1: no redirect following. undici request() default is 0 redirects.
        },
      );

      // -----------------------------------------------------------------------
      // 8. Build FetchResult — lowercase all header keys
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

      const body = await response.body.text();

      return {
        url: rawUrl,
        status: response.statusCode,
        headers,
        body,
        redirectChain: [],
        error: undefined,
      };
    } catch (err) {
      // Timeout detection
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes("timeout") ||
        errMsg.includes("Timeout") ||
        errMsg.includes("UND_ERR_HEADERS_TIMEOUT") ||
        errMsg.includes("UND_ERR_BODY_TIMEOUT")
      ) {
        return buildErrorResult(rawUrl, FetchErrorCode.CONNECT_TIMEOUT);
      }
      return buildErrorResult(rawUrl, FetchErrorCode.FETCH_ERROR);
    }
  };
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
