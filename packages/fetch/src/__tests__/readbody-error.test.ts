/**
 * readBodyBounded error-containment regression tests.
 *
 * Guards the BUG #3 crash: a decompressor that errors mid-pipeline (e.g. a brotli
 * decoder fed bytes it can't decode — which is exactly what happens on Bun's
 * baseline node:zlib brotli) must REJECT gracefully, never emit an unhandled
 * 'error' event that crashes the process. `.pipe()` does not forward errors, so
 * every stage must have its own error handler.
 */

import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { readBodyBounded } from "../safe-fetcher.js";
import { buildDecompressChain } from "../decompression.js";

const MAX = 5_000_000;

/** Build an async-iterable body (undici-shaped) from buffers. */
function bodyOf(...bufs: Buffer[]): { [Symbol.asyncIterator](): AsyncIterator<Buffer> } {
  return {
    async *[Symbol.asyncIterator]() {
      for (const b of bufs) yield b;
    },
  };
}

describe("readBodyBounded error containment", () => {
  it("rejects (does not crash) when a brotli decompressor fails on bad bytes", async () => {
    // 'br' decompressor is a MIDDLE stage (byte counter is appended after it),
    // so its error only surfaces if every stage is error-handled.
    const chain = buildDecompressChain("br", MAX);
    const garbage = Buffer.from("this is definitely not a valid brotli stream");
    await expect(readBodyBounded(bodyOf(garbage), chain, MAX)).rejects.toBeTruthy();
  });

  it("falls back to raw bytes when the FIRST stage sees a gzip header-format error (BUG: FETCH_ERROR on every prod audit, 2026-07-27)", async () => {
    // This is not "bad bytes" in the corrupt-stream sense the brotli test above
    // covers — it's the exact shape of the production failure: Bun's undici
    // `request()` transparently decompresses gzip bodies over real sockets while
    // the Content-Encoding response header still says "gzip". createGunzip() then
    // receives already-plaintext bytes and throws Z_DATA_ERROR "incorrect header
    // check" on the very first stage, with zero decompressed output produced yet.
    // Rejecting here (the old behavior) turned every real-world gzip response
    // into FETCH_ERROR — 100% of production audits failed this way. The correct
    // behavior is to treat the header-format error as "wasn't actually
    // compressed" and use the raw bytes.
    const chain = buildDecompressChain("gzip", MAX);
    const alreadyPlaintext = "not gzip — this is what Bun hands us post-decompress";
    const out = await readBodyBounded(bodyOf(Buffer.from(alreadyPlaintext)), chain, MAX);
    expect(out).toBe(alreadyPlaintext);
  });

  it("decodes a valid gzip body through the chain", async () => {
    const chain = buildDecompressChain("gzip", MAX);
    const payload = "<html>hello geo</html>";
    const out = await readBodyBounded(bodyOf(gzipSync(Buffer.from(payload))), chain, MAX);
    expect(out).toBe(payload);
  });

  it("passes an identity body through with only a size cap", async () => {
    const out = await readBodyBounded(bodyOf(Buffer.from("plain body")), [], MAX);
    expect(out).toBe("plain body");
  });
});
