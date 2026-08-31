/**
 * Real-socket decompression regression test (Bun transparent-decompression bug).
 *
 * Every other test in this package drives the decompression chain through
 * undici's MockAgent seam (_testDispatcher), which never opens a real socket —
 * exactly why the Bun quirk (Content-Encoding: gzip header present, body
 * already plaintext on the wire) shipped to production undetected for 7 weeks
 * with zero successful audits. This test opens a REAL TCP connection via
 * undici's `request()` (the same call safe-fetcher.ts makes) to a real Node
 * http.Server serving a genuinely gzip-compressed body, and proves
 * readBodyBounded decodes it correctly end to end over that real socket.
 *
 * This intentionally does NOT go through createSafeFetcher() — 127.0.0.1 is
 * always SSRF_BLOCKED_IP by design (loopback), and that deny-list must not be
 * touched or weakened to make a test pass. SSRF/redirect coverage stays with
 * the existing mocked createSafeFetcher tests; this test isolates the
 * real-socket decompression path (buildDecompressChain + readBodyBounded)
 * that safe-fetcher.ts feeds from the pinned undici request.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "undici";
import { gzipSync } from "node:zlib";
import { createTestServer, type TestServer } from "../../test/helpers/test-server.js";
import { readBodyBounded } from "../safe-fetcher.js";
import { buildDecompressChain } from "../decompression.js";

const HTML = '<!doctype html><html lang="en"><body>hello geo</body></html>';
const MAX_BYTES = 5_000_000;

describe("real-socket decompression (undici request() over a real loopback TCP connection)", () => {
  let srv: TestServer;

  beforeAll(async () => {
    srv = await createTestServer((_req, res) => {
      const gzipped = gzipSync(Buffer.from(HTML));
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
        "content-length": gzipped.length,
      });
      res.end(gzipped);
    });
  });

  afterAll(async () => {
    await srv.close();
  });

  it("decodes a genuinely gzip-compressed real-socket response back to the original HTML", async () => {
    const response = await request(srv.url);
    expect(response.headers["content-encoding"]).toBe("gzip");

    const chain = buildDecompressChain("gzip", MAX_BYTES);
    const body = await readBodyBounded(response.body, chain, MAX_BYTES);

    expect(body).toBe(HTML);
  });
});
