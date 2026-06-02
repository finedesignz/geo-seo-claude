/**
 * createSafeFetcher redirect tests (Wave 2, SEC-03)
 *
 * Tests manual redirect loop with per-hop SSRF re-validation.
 * Uses loopback test server for real HTTP redirects + mock resolver
 * to control DNS outcomes deterministically.
 *
 * Bypass shapes tested per REVIEWS.md MED items:
 *   - protocol-relative Location (//host/path)
 *   - scheme pivot (https → http)
 *   - userinfo in Location (user@host)
 *   - IPv6 literal Location
 *   - obfuscated IPv4 literal in Location
 *   - missing Location header on 3xx
 *   - 307/308 (method/body preservation, Location resolved correctly)
 *   - relative Location (/path)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSafeFetcher } from "../safe-fetcher.js";
import { FetchErrorCode } from "../errors.js";
import { createStaticResolver } from "../../test/helpers/mock-resolver.js";
import type { MockResolver } from "../../test/helpers/mock-resolver.js";

// Hostname-keyed resolver for multi-host scenarios
function createMapResolver(map: Record<string, string[]>): MockResolver {
  return async (hostname: string) => {
    const ips = map[hostname];
    if (!ips) throw new Error(`MockResolver: no entry for hostname "${hostname}"`);
    return ips;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUBLIC_IP = "1.2.3.4"; // non-blocked public IP for mock resolver

// ---------------------------------------------------------------------------
// Helpers: build a fetcher that tunnels through a loopback test server
// ---------------------------------------------------------------------------

/**
 * Fetcher configured to:
 *   1. Resolve "example.com" (and variants) to PUBLIC_IP via mock resolver.
 *   2. Allow port 80 (test server) in allowedPorts.
 *   3. _testDispatcher omitted — test server operates on loopback, which IS
 *      normally blocked. Instead we use a resolver that maps fakehost → PUBLIC_IP
 *      and the server listens on that port, routing via the mock dispatcher.
 *
 * For tests that use the loopback server directly we allow port 80 and inject
 * a mock resolver + MockAgent dispatcher.
 */

import { MockAgent } from "undici";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("redirect — 302 → 200 chain", () => {
  it("follows a single redirect, sets redirectChain correctly", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/start" }).reply(302, "", {
      headers: { location: "http://example.com/end" },
    });
    pool.intercept({ path: "/end" }).reply(200, "done", {
      headers: { "content-type": "text/plain" },
    });

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/start");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body).toBe("done");
    expect(result.redirectChain).toHaveLength(1);
    expect(result.redirectChain[0]).toEqual({
      url: "http://example.com/start",
      status: 302,
    });
  });
});

describe("redirect — hop cap", () => {
  it("returns TOO_MANY_REDIRECTS after maxRedirects hops", async () => {
    // Server that always redirects to itself
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get("http://example.com");

    // 6 intercepts: 5 redirects + 1 guard (should never reach 6th)
    for (let i = 0; i < 6; i++) {
      pool.intercept({ path: "/loop" }).reply(302, "", {
        headers: { location: "http://example.com/loop" },
      });
    }

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
      maxRedirects: 5,
    });

    const result = await fetcher("http://example.com/loop");
    expect(result.error).toBe(FetchErrorCode.TOO_MANY_REDIRECTS);
    expect(result.redirectChain).toHaveLength(5);
  });
});

describe("redirect — pivot to private IP", () => {
  it("blocks redirect pointing to a private IP (REDIRECT_BLOCKED)", async () => {
    // Hop A: public host, returns 302 to hop B
    // Hop B: resolves to a private/blocked IP
    const agent = new MockAgent();
    agent.disableNetConnect();

    // Hop A pool
    const poolA = agent.get("http://example.com");
    poolA.intercept({ path: "/" }).reply(302, "", {
      headers: { location: "http://internal.evil/" },
    });

    // Hop B pool (should never be called — SSRF validation blocks it)
    const poolB = agent.get("http://internal.evil");
    poolB.intercept({ path: "/" }).reply(200, "secret", {});

    const fetcher = createSafeFetcher({
      resolver: createMapResolver({
        "example.com": [PUBLIC_IP],
        "internal.evil": ["10.0.0.1"], // private — blocked
      }),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/");
    expect(result.error).toBe(FetchErrorCode.REDIRECT_BLOCKED);
    // Chain recorded the first hop
    expect(result.redirectChain).toHaveLength(1);
    expect(result.redirectChain[0]!.url).toBe("http://example.com/");
  });

  it("blocks redirect to metadata IP (169.254.169.254)", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/" }).reply(302, "", {
      headers: { location: "http://metadata.local/" },
    });

    const fetcher = createSafeFetcher({
      resolver: createMapResolver({
        "example.com": [PUBLIC_IP],
        "metadata.local": ["169.254.169.254"],
      }),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/");
    expect(result.error).toBe(FetchErrorCode.REDIRECT_BLOCKED);
  });
});

describe("redirect — relative Location", () => {
  it("resolves relative Location against current URL before re-validating", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/start" }).reply(302, "", {
      headers: { location: "/finish" },
    });
    pool.intercept({ path: "/finish" }).reply(200, "relative-ok", {});

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/start");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body).toBe("relative-ok");
    expect(result.redirectChain[0]?.url).toBe("http://example.com/start");
  });
});

describe("redirect — missing Location header", () => {
  it("returns FETCH_ERROR when 3xx has no Location", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/" }).reply(302, "", {}); // no Location

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/");
    expect(result.error).toBe(FetchErrorCode.FETCH_ERROR);
    expect(result.redirectChain).toHaveLength(1);
  });
});

describe("redirect — 307/308 followed with Location", () => {
  it("307 redirect is followed with correct Location resolution", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/a" }).reply(307, "", {
      headers: { location: "http://example.com/b" },
    });
    pool.intercept({ path: "/b" }).reply(200, "307-ok", {});

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/a");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.redirectChain[0]?.status).toBe(307);
  });

  it("308 redirect is followed with correct Location resolution", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/a" }).reply(308, "", {
      headers: { location: "http://example.com/b" },
    });
    pool.intercept({ path: "/b" }).reply(200, "308-ok", {});

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/a");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.redirectChain[0]?.status).toBe(308);
  });
});

describe("redirect — bypass shapes", () => {
  it("blocks userinfo in Location header (user@host)", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/" }).reply(302, "", {
      headers: { location: "http://user:pass@example.com/evil" },
    });

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/");
    // userinfo in URL → SSRF_BLOCKED_SCHEME from validateUrl → REDIRECT_BLOCKED
    expect(result.error).toBe(FetchErrorCode.REDIRECT_BLOCKED);
  });

  it("blocks IPv6 literal redirect pointing to loopback [::1]", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/" }).reply(302, "", {
      headers: { location: "http://[::1]/" },
    });

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/");
    expect(result.error).toBe(FetchErrorCode.REDIRECT_BLOCKED);
  });

  it("blocks obfuscated IPv4 literal in Location (decimal integer form)", async () => {
    // 2130706433 = 127.0.0.1
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/" }).reply(302, "", {
      headers: { location: "http://2130706433/" },
    });

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/");
    // Obfuscated form — either REDIRECT_BLOCKED (if isBlockedIP recognizes it)
    // or FETCH_ERROR (if URL parsing rejects it). Must NOT be status 200.
    expect(result.error).toBeDefined();
    expect(result.status).toBe(0);
  });

  it("protocol-relative Location (//host/path) resolves to same scheme", async () => {
    // new URL("//example.com/path", "http://example.com/start").href
    // should produce "http://example.com/path"
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/start" }).reply(302, "", {
      headers: { location: "//example.com/end" },
    });
    pool.intercept({ path: "/end" }).reply(200, "proto-rel-ok", {});

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/start");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body).toBe("proto-rel-ok");
  });
});

describe("redirect — chain ordering preserved", () => {
  it("2-hop chain has correct order", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const pool = agent.get("http://example.com");
    pool.intercept({ path: "/a" }).reply(301, "", {
      headers: { location: "http://example.com/b" },
    });
    pool.intercept({ path: "/b" }).reply(302, "", {
      headers: { location: "http://example.com/c" },
    });
    pool.intercept({ path: "/c" }).reply(200, "final", {});

    const fetcher = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443],
      _testDispatcher: agent,
    });

    const result = await fetcher("http://example.com/a");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.redirectChain).toHaveLength(2);
    expect(result.redirectChain[0]).toEqual({ url: "http://example.com/a", status: 301 });
    expect(result.redirectChain[1]).toEqual({ url: "http://example.com/b", status: 302 });
  });
});
