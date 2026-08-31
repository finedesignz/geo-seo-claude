/**
 * Skeleton e2e test — Wave 1 contract
 *
 * The "blocks 169.254.169.254" assertion is now live (Wave 1 implemented).
 * Remaining tests stay as .todo until Wave 2/3 features are built.
 */

import { describe, it, expect } from "vitest";
import { createSafeFetcher } from "../safe-fetcher.js";
import { FetchErrorCode } from "../errors.js";

describe("createSafeFetcher (Wave 1 — e2e assertions)", () => {
  it("blocks 169.254.169.254 with SSRF_BLOCKED_IP error code", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://169.254.169.254/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("blocks loopback 127.0.0.1 with SSRF_BLOCKED_IP error code", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://127.0.0.1/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("blocks private 10.0.0.1 with SSRF_BLOCKED_IP error code", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://10.0.0.1/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("blocks file:// scheme with SSRF_BLOCKED_SCHEME error code", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("file:///etc/passwd");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_SCHEME);
  });

  it("blocks javascript:// scheme with SSRF_BLOCKED_SCHEME error code", async () => {
    const fetch = createSafeFetcher();
    // javascript: is not a valid URL host so URL constructor throws → SSRF_BLOCKED_SCHEME
    const result = await fetch("javascript:alert(1)");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_SCHEME);
  });

  it.todo("follows public redirect and returns 200 body");
  it.todo("blocks redirect to private IP with REDIRECT_BLOCKED error code");
  it.todo("aborts after too many redirects with TOO_MANY_REDIRECTS error code");
  it.todo("aborts oversized response with RESPONSE_TOO_LARGE error code");
  it.todo("times out slow connection with CONNECT_TIMEOUT error code");
  it.todo("returns DNS_RESOLUTION_FAILED when host does not resolve");
  it.todo("blocks DNS-rebinding: second call returns private IP after public first call");
});
