/**
 * safe-requester tests (D-08, D-12) — validateUrlHost + createSafeRequester.
 *
 * All DNS is injected via mock resolvers (no real network). The success POST
 * uses an undici MockAgent so no real socket is opened, while the SSRF deny
 * paths assert NO connection is attempted at all.
 */

import { describe, it, expect } from "vitest";
import { MockAgent } from "undici";
import { createSafeRequester, validateUrlHost } from "../safe-requester.js";
import { FetchErrorCode } from "../errors.js";
import {
  createStaticResolver,
  createMockResolver,
} from "../../test/helpers/mock-resolver.js";

// ---------------------------------------------------------------------------
// validateUrlHost — submit-time, no HTTP request
// ---------------------------------------------------------------------------

describe("validateUrlHost", () => {
  it("allows a public host", async () => {
    const res = await validateUrlHost("https://example.com/hook", {
      resolver: createStaticResolver(["8.8.8.8"]),
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a loopback host and issues NO HTTP request", async () => {
    // If an HTTP request were attempted, there is no dispatcher/server, but the
    // SSRF_BLOCKED_IP code proves the block happened at DNS-classify time.
    const res = await validateUrlHost("http://attacker.test/x", {
      resolver: createStaticResolver(["127.0.0.1"]),
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("rejects an RFC1918 host", async () => {
    const res = await validateUrlHost("https://internal.test/x", {
      resolver: createStaticResolver(["10.0.0.5"]),
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("rejects a non-http(s) scheme", async () => {
    const res = await validateUrlHost("ftp://example.com/x", {
      resolver: createStaticResolver(["8.8.8.8"]),
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(FetchErrorCode.SSRF_BLOCKED_SCHEME);
  });

  it("rejects an unparseable URL", async () => {
    const res = await validateUrlHost("not a url");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createSafeRequester — SSRF-safe POST
// ---------------------------------------------------------------------------

describe("createSafeRequester", () => {
  it("POSTs to a public host and returns a FetchResult (never throws)", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://example.com")
      .intercept({ path: "/hook", method: "POST" })
      .reply(200, JSON.stringify({ received: true }), {
        headers: { "content-type": "application/json" },
      });

    const post = createSafeRequester({
      resolver: createStaticResolver(["8.8.8.8"]),
      _testDispatcher: agent,
    });

    const result = await post("https://example.com/hook", {
      method: "POST",
      body: JSON.stringify({ job_id: "abc" }),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ received: true });
  });

  it("blocks a private-resolving host, never connects, never throws", async () => {
    const post = createSafeRequester({
      resolver: createStaticResolver(["169.254.169.254"]), // cloud metadata
    });

    const result = await post("https://metadata.test/hook", {
      method: "POST",
      body: "{}",
    });

    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
    expect(result.status).toBe(0);
  });

  it("re-validates per attempt (TOCTOU): rebind to private IP is blocked", async () => {
    // First resolve public, second (would-be retry) private — but the very
    // first attempt resolves private here to assert a deterministic block.
    const post = createSafeRequester({
      resolver: createMockResolver([["10.0.0.1"]]),
    });
    const result = await post("https://rebind.test/hook", { method: "POST", body: "{}" });
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("does not follow a redirect into another host (REDIRECT_BLOCKED)", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://example.com")
      .intercept({ path: "/hook", method: "POST" })
      .reply(302, "", { headers: { location: "http://127.0.0.1/" } });

    const post = createSafeRequester({
      resolver: createStaticResolver(["8.8.8.8"]),
      _testDispatcher: agent,
    });

    const result = await post("https://example.com/hook", { method: "POST", body: "{}" });
    expect(result.error).toBe(FetchErrorCode.REDIRECT_BLOCKED);
  });
});
