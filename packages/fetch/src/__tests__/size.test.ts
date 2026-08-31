/**
 * Size cap + decompression-bomb integration tests (SEC-04)
 *
 * Uses a loopback test server and injects a mock resolver pointing
 * 'example.test' to 127.0.0.1 (non-blocked). The _testDispatcher seam
 * bypasses the undici routing to the real loopback server.
 *
 * Scenarios:
 *   1. Content-Length > maxBytes → RESPONSE_TOO_LARGE (early reject)
 *   2. Chunked body exceeding maxBytes → RESPONSE_TOO_LARGE (streamed counter)
 *   3. Content-Encoding: gzip bomb → DECOMPRESSION_BOMB
 *   4. Content-Encoding: gzip,gzip,gzip → DECOMPRESSION_BOMB
 *   5. Under-cap body → 200 with correct body string
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSafeFetcher } from "../safe-fetcher.js";
import { FetchErrorCode } from "../errors.js";
import { createTestServer, type TestServer } from "../../test/helpers/test-server.js";
import { createMockResolver } from "../../test/helpers/mock-resolver.js";

// 127.0.0.1 is allowed (not in the blocked list — it IS blocked as loopback).
// We use the _testDispatcher seam to route without IP pinning to localhost.
// The resolver returns a public IP; _testDispatcher routes to test server.

import { MockAgent } from "undici";

const MAX_BYTES = 1_000; // small cap for test speed

let srv: TestServer;

function buildFetcher(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  // We need the fetcher to route to our test server.
  // Use createTestServer + _testDispatcher pattern.
  return { handler };
}

describe("size cap and decompression bomb", () => {
  let srv: TestServer;
  let mockAgent: MockAgent;

  beforeEach(async () => {
    // Server is created per-test via helper; mock agent intercepts per-test
  });

  afterEach(async () => {
    if (srv) await srv.close().catch(() => {});
    if (mockAgent) await mockAgent.close().catch(() => {});
  });

  // Helper: creates fetcher routed through a MockAgent intercepting 'http://example.test'
  // to our loopback server's actual port.
  async function setupFetcherWithServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ) {
    srv = await createTestServer(handler);

    // MockAgent intercepts requests to example.test and proxies them to our server
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const pool = mockAgent.get("http://example.test");
    // We'll use a path-agnostic intercept via the real server
    // Instead, we use the loopback server URL directly with a public-IP resolver trick
    // But _testDispatcher routes requests to example.test, not to 127.0.0.1:PORT.
    // Solution: use createTestServer URL directly and a resolver returning 1.2.3.4,
    // then let MockAgent rewrite to the test server port.

    // Actually, we need a different approach: use the test server URL with
    // allowedPorts including the ephemeral port, and a resolver returning
    // a non-blocked IP, and _testDispatcher routing to the test server.

    const fetcher = createSafeFetcher({
      maxBytes: MAX_BYTES,
      allowedPorts: [80, 443, srv.port],
      resolver: createMockResolver([["1.2.3.4"], ["1.2.3.4"], ["1.2.3.4"], ["1.2.3.4"], ["1.2.3.4"]]),
      _testDispatcher: mockAgent,
    });

    // MockAgent needs to intercept http://example.test (port 80 default)
    // But our server is on a non-80 port.
    // We need to intercept http://example.test:PORT

    const mockPool = mockAgent.get(`http://example.test:${srv.port}`);

    return { fetcher, mockPool, srvUrl: srv.url, port: srv.port };
  }

  it("Content-Length > maxBytes → RESPONSE_TOO_LARGE (early reject)", async () => {
    const { fetcher, mockPool } = await setupFetcherWithServer((_req, res) => {
      res.writeHead(200, { "Content-Length": String(MAX_BYTES + 100) });
      res.end("x".repeat(MAX_BYTES + 100));
    });

    mockPool
      .intercept({ path: "/test", method: "GET" })
      .reply(200, "x".repeat(MAX_BYTES + 100), {
        headers: { "content-length": String(MAX_BYTES + 100) },
      });

    const result = await fetcher(`http://example.test:${srv.port}/test`);
    expect(result.error).toBe(FetchErrorCode.RESPONSE_TOO_LARGE);
  });

  it("chunked body exceeding maxBytes → RESPONSE_TOO_LARGE (streamed)", async () => {
    const { fetcher, mockPool } = await setupFetcherWithServer((_req, res) => {
      res.writeHead(200);
      res.write("x".repeat(MAX_BYTES + 1));
      res.end();
    });

    mockPool
      .intercept({ path: "/chunked", method: "GET" })
      .reply(200, "x".repeat(MAX_BYTES + 1)); // no content-length header

    const result = await fetcher(`http://example.test:${srv.port}/chunked`);
    expect(result.error).toBe(FetchErrorCode.RESPONSE_TOO_LARGE);
  });

  it("gzip bomb → DECOMPRESSION_BOMB", async () => {
    // 10KB of zeros compressed → small compressed, large decompressed
    const bomb = gzipSync(Buffer.alloc(MAX_BYTES * 20, 0x00));

    const { fetcher, mockPool } = await setupFetcherWithServer((_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(bomb);
    });

    mockPool
      .intercept({ path: "/bomb", method: "GET" })
      .reply(200, bomb, {
        headers: { "content-encoding": "gzip" },
      });

    const result = await fetcher(`http://example.test:${srv.port}/bomb`);
    expect(result.error).toBe(FetchErrorCode.DECOMPRESSION_BOMB);
  });

  it("3 stacked gzip encodings → DECOMPRESSION_BOMB", async () => {
    const { fetcher, mockPool } = await setupFetcherWithServer((_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip, gzip, gzip" });
      res.end("x");
    });

    mockPool
      .intercept({ path: "/stacked", method: "GET" })
      .reply(200, "x", {
        headers: { "content-encoding": "gzip, gzip, gzip" },
      });

    const result = await fetcher(`http://example.test:${srv.port}/stacked`);
    expect(result.error).toBe(FetchErrorCode.DECOMPRESSION_BOMB);
  });

  it("BUG regression: Content-Encoding: gzip header but already-plaintext body → 200 with raw body (not FETCH_ERROR)", async () => {
    // Reproduces the production FETCH_ERROR: Bun's undici `request()` transparently
    // decompresses gzip/deflate bodies over real sockets while the Content-Encoding
    // response header still reports "gzip". The prior implementation always ran
    // createGunzip() on the (already-plaintext) bytes, which threw a zlib
    // Z_DATA_ERROR "incorrect header check" — caught and surfaced as FETCH_ERROR
    // on every single real-world audit (100% failure rate, BUG report 2026-07-27).
    // This test's mock server sends plaintext with a lying Content-Encoding: gzip
    // header — the exact shape undici's real body looks like on Bun.
    const body = "<!doctype html><html><body>hello</body></html>";

    const { fetcher, mockPool } = await setupFetcherWithServer((_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(body);
    });

    mockPool
      .intercept({ path: "/lying-encoding", method: "GET" })
      .reply(200, body, {
        headers: { "content-encoding": "gzip" },
      });

    const result = await fetcher(`http://example.test:${srv.port}/lying-encoding`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body).toBe(body);
  });

  it("under-cap body → 200 with correct body string", async () => {
    const body = "hello world";

    const { fetcher, mockPool } = await setupFetcherWithServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
    });

    mockPool
      .intercept({ path: "/ok", method: "GET" })
      .reply(200, body, {
        headers: { "content-type": "text/plain" },
      });

    const result = await fetcher(`http://example.test:${srv.port}/ok`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body).toBe(body);
  });
});
