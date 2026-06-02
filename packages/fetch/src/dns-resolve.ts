/**
 * @geo/fetch — DNS pre-resolution with SSRF validation (SEC-01, SEC-02)
 *
 * resolveAndValidate(hostname, resolver?) → Promise<string[]>
 *
 * Strategy:
 *   1. Resolve ALL A + AAAA records via resolve4 + resolve6 (NOT dns.lookup).
 *   2. If zero records → throw with code DNS_RESOLUTION_FAILED.
 *   3. If ANY record isBlockedIP → throw with code SSRF_BLOCKED_IP.
 *      (Do NOT silently drop bad records — any blocked record poisons the set.)
 *   4. Return the full validated IP list for caller to pin a connection to.
 *
 * The resolver is injectable so tests can mock DNS without real network.
 */

import * as dns from "node:dns/promises";
import { isBlockedIP } from "./ip-validator.js";
import { FetchErrorCode } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable resolver: (hostname) → all A+AAAA addresses for that host */
export type Resolver = (hostname: string) => Promise<string[]>;

/** Error thrown when resolveAndValidate rejects */
export class DnsValidationError extends Error {
  readonly code: FetchErrorCode;

  constructor(code: FetchErrorCode, message: string) {
    super(message);
    this.name = "DnsValidationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Default resolver (node:dns/promises resolve4 + resolve6)
// ---------------------------------------------------------------------------

/**
 * Default DNS resolver: aggregates ALL A + AAAA records.
 * Uses resolve4/resolve6 (NOT dns.lookup) so every record is fetched.
 */
async function defaultResolver(hostname: string): Promise<string[]> {
  const [v4Result, v6Result] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const addresses: string[] = [];

  if (v4Result.status === "fulfilled") {
    addresses.push(...v4Result.value);
  }
  if (v6Result.status === "fulfilled") {
    addresses.push(...v6Result.value);
  }

  return addresses;
}

// ---------------------------------------------------------------------------
// resolveAndValidate
// ---------------------------------------------------------------------------

/**
 * Resolves hostname to all A+AAAA records and validates each against the
 * SSRF IP block list. Throws DnsValidationError on failure.
 *
 * @param hostname - The hostname to resolve (no scheme, no port).
 * @param resolver - Injectable resolver; defaults to resolve4+resolve6.
 * @returns Validated IP address list (safe to connect to).
 * @throws DnsValidationError with code DNS_RESOLUTION_FAILED | SSRF_BLOCKED_IP
 */
export async function resolveAndValidate(
  hostname: string,
  resolver: Resolver = defaultResolver,
): Promise<string[]> {
  let addresses: string[];

  try {
    addresses = await resolver(hostname);
  } catch (err) {
    throw new DnsValidationError(
      FetchErrorCode.DNS_RESOLUTION_FAILED,
      `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (addresses.length === 0) {
    throw new DnsValidationError(
      FetchErrorCode.DNS_RESOLUTION_FAILED,
      `DNS resolution returned no records for ${hostname}`,
    );
  }

  for (const ip of addresses) {
    if (isBlockedIP(ip)) {
      throw new DnsValidationError(
        FetchErrorCode.SSRF_BLOCKED_IP,
        `Resolved IP ${ip} for ${hostname} is in a blocked range`,
      );
    }
  }

  return addresses;
}
