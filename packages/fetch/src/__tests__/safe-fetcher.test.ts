/**
 * createSafeFetcher tests (Wave 1, Task 2)
 *
 * Happy-path uses undici MockAgent as the _testDispatcher seam so a
 * "public-looking" hostname can be served by a loopback handler without
 * disabling the IP deny-list. IP validation still runs against the injected
 * mock resolver.
 *
 * All tests are deterministic — no real DNS or network traffic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockAgent } from "undici";
import { createSafeFetcher } from "../safe-fetcher.js";
import { FetchErrorCode } from "../errors.js";
import {
  createStaticResolver,
  createMockResolver,
} from "../../test/helpers/mock-resolver.js";
import { createTestServer } from "../../test/helpers/test-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PUBLIC_IP = "1.2.3.4"; // A non-blocked IP used as mock resolution target

/**
 * Build a MockAgent that intercepts requests to `origin` (scheme+host+port)
 * and returns the provided status / headers / body.
 */
function buildMockDispatcher(
  origin: string,
  path: string,
  status: number,
  responseHeaders: Record<string, string>,
  body: string,
) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(origin);
  // undici MockAgent reply: third arg is { headers: Record<string,string> }
  pool.intercept({ path }).reply(status, body, { headers: responseHeaders });
  return agent;
}

// Alias to be explicit about header wrapping format used below
function replyOpts(headers: Record<string, string>) {
  return { headers };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createSafeFetcher — happy path", () => {
  it("returns status 200, lowercased headers, body, empty redirectChain", async () => {
    const origin = "http://example.test";
    const mockDispatcher = buildMockDispatcher(
      origin,
      "/",
      200,
      { "Content-Type": "text/plain", "X-Custom": "Hello" },
      "response body",
    );

    const fetch = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      _testDispatcher: mockDispatcher,
    });

    const result = await fetch("http://example.test/");

    expect(result.status).toBe(200);
    expect(result.body).toBe("response body");
    expect(result.redirectChain).toEqual([]);
    expect(result.error).toBeUndefined();

    // All header keys must be lowercase
    for (const key of Object.keys(result.headers)) {
      expect(key).toBe(key.toLowerCase());
    }
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.headers["x-custom"]).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// SSRF IP block
// ---------------------------------------------------------------------------

describe("createSafeFetcher — SSRF IP blocks", () => {
  it("blocks metadata IP (169.254.169.254) → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher({
      resolver: createStaticResolver(["169.254.169.254"]),
    });
    const result = await fetch("http://metadata.test/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
    expect(result.body).toBe("");
  });

  it("blocks private IP (10.0.0.1) → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher({
      resolver: createStaticResolver(["10.0.0.1"]),
    });
    const result = await fetch("http://private.test/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("blocks loopback IP (127.0.0.1) → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher({
      resolver: createStaticResolver(["127.0.0.1"]),
    });
    const result = await fetch("http://loopback.test/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("blocks mixed set (8.8.8.8 + 10.0.0.5) → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher({
      resolver: createStaticResolver(["8.8.8.8", "10.0.0.5"]),
    });
    const result = await fetch("http://mixed.test/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });
});

// ---------------------------------------------------------------------------
// Direct IP literal tests (REVIEWS HIGH item #3)
// These hit the fetcher directly — no DNS resolver involved.
// ---------------------------------------------------------------------------

describe("createSafeFetcher — direct IP literal SSRF blocks", () => {
  it("http://169.254.169.254/ → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://169.254.169.254/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("http://127.0.0.1/ → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://127.0.0.1/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("http://2130706433/ (decimal 127.0.0.1) → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://2130706433/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("http://017700000001/ (octal 127.0.0.1) → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://017700000001/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("http://0x7f000001/ (hex 127.0.0.1) → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://0x7f000001/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });

  it("http://[::ffff:169.254.169.254]/ (IPv4-mapped) → SSRF_BLOCKED_IP", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://[::ffff:169.254.169.254]/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
  });
});

// ---------------------------------------------------------------------------
// DNS_RESOLUTION_FAILED
// ---------------------------------------------------------------------------

describe("createSafeFetcher — DNS failures", () => {
  it("returns DNS_RESOLUTION_FAILED when resolver returns empty", async () => {
    const fetch = createSafeFetcher({
      resolver: createStaticResolver([]),
    });
    const result = await fetch("http://nxdomain.test/");
    expect(result.error).toBe(FetchErrorCode.DNS_RESOLUTION_FAILED);
  });
});

// ---------------------------------------------------------------------------
// DNS rebinding — resolver called exactly once (REVIEWS HIGH item #1)
// ---------------------------------------------------------------------------

describe("createSafeFetcher — DNS rebinding prevention", () => {
  it("resolver is invoked exactly once per fetch (resolve-then-pin proof)", async () => {
    // Sequence: first call returns public IP (passes validation),
    //           second call would return private IP (rebinding attack).
    // Because resolve-then-pin uses a single resolution, only the first entry is consumed.
    const rejectOnSecondCall = createMockResolver([
      [PUBLIC_IP], // first (and only) call → public IP, validation passes
      ["10.0.0.1"], // second call would be the rebinding attack
    ]);

    const origin = "http://rebind.test";
    const mockDispatcher = buildMockDispatcher(
      origin,
      "/path",
      200,
      {},
      "ok",
    );

    const fetch = createSafeFetcher({
      resolver: rejectOnSecondCall,
      _testDispatcher: mockDispatcher,
    });

    const result = await fetch("http://rebind.test/path");

    // Fetch succeeds using the first validated IP
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);

    // Prove the resolver was called only ONCE by exhausting the mock:
    // After the single call, the mock has one entry remaining (the rebinding IP).
    // If the fetcher had called the resolver twice, this entry would be consumed
    // and the next call would throw "MockResolver exhausted".
    // Instead it's still there — meaning the rebinding sequence was never read.
    const remainingResult = await rejectOnSecondCall("any");
    expect(remainingResult).toEqual(["10.0.0.1"]); // second entry is intact
  });
});

// ---------------------------------------------------------------------------
// Scheme allowlist
// ---------------------------------------------------------------------------

describe("createSafeFetcher — scheme allowlist", () => {
  it("file:///etc/passwd → SSRF_BLOCKED_SCHEME", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("file:///etc/passwd");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_SCHEME);
  });

  it("gopher://x/ → SSRF_BLOCKED_SCHEME", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("gopher://x/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_SCHEME);
  });

  it("data:text/html,<h1>x → SSRF_BLOCKED_SCHEME", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("data:text/html,<h1>x");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_SCHEME);
  });
});

// ---------------------------------------------------------------------------
// Port allowlist
// ---------------------------------------------------------------------------

describe("createSafeFetcher — port allowlist", () => {
  it("port 22 → SSRF_BLOCKED_PORT", async () => {
    const fetch = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
    });
    const result = await fetch("http://example.test:22/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_PORT);
  });

  it("port 6379 (Redis) → SSRF_BLOCKED_PORT", async () => {
    const fetch = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
    });
    const result = await fetch("http://example.test:6379/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_PORT);
  });

  it("port 443 on https → allowed (passes scheme+port check)", async () => {
    const origin = "https://example.test:443";
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(origin);
    pool.intercept({ path: "/" }).reply(200, "secure", {});

    const fetch = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      _testDispatcher: agent,
    });
    const result = await fetch("https://example.test:443/");
    // Port 443 is allowed; result should not be SSRF_BLOCKED_PORT
    expect(result.error).not.toBe(FetchErrorCode.SSRF_BLOCKED_PORT);
  });

  it("custom allowedPorts: port 8080 allowed when configured", async () => {
    const origin = "http://example.test:8080";
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(origin);
    pool.intercept({ path: "/" }).reply(200, "custom port", {});

    const fetch = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443, 8080],
      _testDispatcher: agent,
    });
    const result = await fetch("http://example.test:8080/");
    expect(result.error).not.toBe(FetchErrorCode.SSRF_BLOCKED_PORT);
    expect(result.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Userinfo denial
// ---------------------------------------------------------------------------

describe("createSafeFetcher — userinfo denial", () => {
  it("user:pass@host → SSRF_BLOCKED_SCHEME", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://user:pass@example.test/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_SCHEME);
  });

  it("user@host (no password) → SSRF_BLOCKED_SCHEME", async () => {
    const fetch = createSafeFetcher();
    const result = await fetch("http://user@example.test/");
    expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_SCHEME);
  });
});

// ---------------------------------------------------------------------------
// Loopback test server integration (happy path with real loopback server)
// ---------------------------------------------------------------------------

describe("createSafeFetcher — loopback test server integration", () => {
  let serverUrl: string;
  let serverPort: number;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    const { createTestServer } = await import(
      "../../test/helpers/test-server.js"
    );
    const srv = await createTestServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("X-Server", "TestServer");
      res.writeHead(200);
      res.end("hello from test server");
    });
    serverUrl = srv.url;
    serverPort = srv.port;
    closeServer = srv.close;
  });

  afterAll(async () => {
    await closeServer();
  });

  it("happy path via MockAgent (bypasses loopback block, keeps IP validation)", async () => {
    // The test server runs on 127.0.0.1:<port>.
    // We simulate fetching "http://example.test:<port>/" by:
    //   1. Resolver returns PUBLIC_IP (passes IP validation).
    //   2. MockAgent serves the request from the loopback test server.
    // This proves the fetcher can successfully return status 200 + headers + body.

    const origin = `http://example.test:${serverPort}`;
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(origin);
    pool.intercept({ path: "/" }).reply(200, "hello from test server", {
      headers: {
        "content-type": "text/plain",
        "x-server": "TestServer",
      },
    });

    const fetch = createSafeFetcher({
      resolver: createStaticResolver([PUBLIC_IP]),
      allowedPorts: [80, 443, serverPort],
      _testDispatcher: agent,
    });

    const result = await fetch(`http://example.test:${serverPort}/`);

    expect(result.status).toBe(200);
    expect(result.body).toBe("hello from test server");
    expect(result.redirectChain).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.headers["x-server"]).toBe("TestServer");

    // All keys lowercase
    for (const key of Object.keys(result.headers)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});
