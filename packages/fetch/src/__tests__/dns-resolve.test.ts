/**
 * dns-resolve.ts unit tests (Wave 1, Task 1)
 *
 * All tests use injected mock resolvers — no real network traffic.
 */

import { describe, it, expect } from "vitest";
import { resolveAndValidate, DnsValidationError } from "../dns-resolve.js";
import {
  createMockResolver,
  createStaticResolver,
} from "../../test/helpers/mock-resolver.js";
import { FetchErrorCode } from "../errors.js";

describe("resolveAndValidate", () => {
  it("returns the IP list for a safe public address", async () => {
    const resolver = createStaticResolver(["8.8.8.8"]);
    const result = await resolveAndValidate("example.test", resolver);
    expect(result).toEqual(["8.8.8.8"]);
  });

  it("rejects with SSRF_BLOCKED_IP when ANY record is private (mixed set)", async () => {
    const resolver = createStaticResolver(["8.8.8.8", "10.0.0.5"]);
    await expect(
      resolveAndValidate("mixed.test", resolver),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DnsValidationError &&
        e.code === FetchErrorCode.SSRF_BLOCKED_IP,
    );
  });

  it("rejects with DNS_RESOLUTION_FAILED when resolver returns empty array", async () => {
    const resolver = createStaticResolver([]);
    await expect(resolveAndValidate("empty.test", resolver)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DnsValidationError &&
        e.code === FetchErrorCode.DNS_RESOLUTION_FAILED,
    );
  });

  it("rejects with SSRF_BLOCKED_IP for link-local metadata IP", async () => {
    const resolver = createStaticResolver(["169.254.169.254"]);
    await expect(
      resolveAndValidate("metadata.test", resolver),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DnsValidationError &&
        e.code === FetchErrorCode.SSRF_BLOCKED_IP,
    );
  });

  it("rejects with SSRF_BLOCKED_IP for loopback address", async () => {
    const resolver = createStaticResolver(["127.0.0.1"]);
    await expect(
      resolveAndValidate("localhost.test", resolver),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DnsValidationError &&
        e.code === FetchErrorCode.SSRF_BLOCKED_IP,
    );
  });

  it("rejects with DNS_RESOLUTION_FAILED when resolver throws", async () => {
    const failingResolver = async (_hostname: string): Promise<string[]> => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      resolveAndValidate("nonexistent.test", failingResolver),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DnsValidationError &&
        e.code === FetchErrorCode.DNS_RESOLUTION_FAILED,
    );
  });

  it("multiple A records — all public → returns all", async () => {
    const resolver = createStaticResolver(["8.8.8.8", "8.8.4.4"]);
    const result = await resolveAndValidate("multi.test", resolver);
    expect(result).toEqual(["8.8.8.8", "8.8.4.4"]);
  });

  it("single-entry sequence resolver — called exactly once", async () => {
    const resolver = createMockResolver([["1.2.3.4"]]);
    await resolveAndValidate("once.test", resolver);
    // If called again the mock would throw — confirms single call
    await expect(resolveAndValidate("again.test", resolver)).rejects.toThrow(
      "MockResolver exhausted",
    );
  });
});
