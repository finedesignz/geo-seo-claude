/**
 * @geo/fetch phase gate — public surface + Fetcher type conformance (SEC-05)
 *
 * Asserts:
 *   1. createSafeFetcher exported and returns a function.
 *   2. All ten FetchErrorCode values present.
 *   3. Returned fetcher is assignable to @geo/core Fetcher (compile-time via tsc,
 *      runtime: returned value is a function that returns a Promise<object with expected shape>).
 */

import { describe, it, expect } from "vitest";
import { createSafeFetcher, FetchErrorCode } from "../index.js";
import type { Fetcher } from "@geo/core";

describe("@geo/fetch public surface", () => {
  it("createSafeFetcher is a function", () => {
    expect(typeof createSafeFetcher).toBe("function");
  });

  it("createSafeFetcher() returns a function", () => {
    const fetcher = createSafeFetcher();
    expect(typeof fetcher).toBe("function");
  });

  it("all ten FetchErrorCode values present", () => {
    const expected = [
      "SSRF_BLOCKED_IP",
      "SSRF_BLOCKED_SCHEME",
      "SSRF_BLOCKED_PORT",
      "DNS_RESOLUTION_FAILED",
      "REDIRECT_BLOCKED",
      "TOO_MANY_REDIRECTS",
      "RESPONSE_TOO_LARGE",
      "DECOMPRESSION_BOMB",
      "CONNECT_TIMEOUT",
      "FETCH_ERROR",
    ];
    expect(Object.keys(FetchErrorCode)).toEqual(expect.arrayContaining(expected));
    expect(Object.keys(FetchErrorCode)).toHaveLength(10);
  });

  it("returned fetcher result has expected FetchResult shape (runtime shape check)", async () => {
    // Use an invalid URL to get a quick error result without network
    const fetcher = createSafeFetcher();
    const result = await fetcher("not-a-valid-url");
    // Should have all FetchResult keys
    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("headers");
    expect(result).toHaveProperty("body");
    expect(result).toHaveProperty("redirectChain");
    expect(Array.isArray(result.redirectChain)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compile-time Fetcher conformance assertion
// This assignment is the tsc gate: if createSafeFetcher() is NOT assignable
// to @geo/core Fetcher, the file fails to compile → `bunx tsc --noEmit` fails.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _conformanceCheck: Fetcher = createSafeFetcher();
