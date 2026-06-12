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

  it("rejects when a gzip decompressor fails on bad bytes", async () => {
    const chain = buildDecompressChain("gzip", MAX);
    await expect(
      readBodyBounded(bodyOf(Buffer.from("not gzip")), chain, MAX),
    ).rejects.toBeTruthy();
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
