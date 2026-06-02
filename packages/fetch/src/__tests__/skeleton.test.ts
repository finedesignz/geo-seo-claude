/**
 * Skeleton e2e test — Wave 1 contract (pending, stays green this wave)
 *
 * Records the expected behaviour of createSafeFetcher before the network
 * implementation exists. Wave 1 will implement and unskip these tests.
 */

import { describe, it } from "vitest";

describe("createSafeFetcher (Wave 1 — pending)", () => {
  it.todo("blocks 169.254.169.254 with SSRF_BLOCKED_IP error code");
  it.todo("blocks loopback 127.0.0.1 with SSRF_BLOCKED_IP error code");
  it.todo("blocks private 10.0.0.1 with SSRF_BLOCKED_IP error code");
  it.todo("blocks file:// scheme with SSRF_BLOCKED_SCHEME error code");
  it.todo("blocks javascript:// scheme with SSRF_BLOCKED_SCHEME error code");
  it.todo("follows public redirect and returns 200 body");
  it.todo("blocks redirect to private IP with REDIRECT_BLOCKED error code");
  it.todo("aborts after too many redirects with TOO_MANY_REDIRECTS error code");
  it.todo("aborts oversized response with RESPONSE_TOO_LARGE error code");
  it.todo("times out slow connection with CONNECT_TIMEOUT error code");
  it.todo("returns DNS_RESOLUTION_FAILED when host does not resolve");
  it.todo("blocks DNS-rebinding: second call returns private IP after public first call");
});
