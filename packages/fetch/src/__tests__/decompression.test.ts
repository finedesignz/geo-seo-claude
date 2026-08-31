/**
 * decompression.ts unit tests — TDD RED phase
 *
 * Tests makeByteCounter and buildDecompressChain.
 * No network: all fixtures built in-process with node:zlib.
 */

import { describe, it, expect } from "vitest";
import { createGzip, gzipSync } from "node:zlib";
import { Readable, pipeline } from "node:stream";
import { promisify } from "node:util";
import { makeByteCounter, buildDecompressChain } from "../decompression.js";
import { FetchErrorCode } from "../errors.js";

const pipelineAsync = promisify(pipeline);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all chunks from a Readable into a Buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Pipe a readable through a series of transforms, collecting result. */
async function pipeThrough(
  source: Buffer,
  transforms: NodeJS.ReadWriteStream[],
): Promise<Buffer> {
  const readable = Readable.from(source);
  if (transforms.length === 0) return collect(readable as unknown as Readable);
  const stages: Array<NodeJS.ReadWriteStream | Readable> = [readable, ...transforms];
  await pipelineAsync(...(stages as Parameters<typeof pipelineAsync>));
  // Collect from last transform
  const last = transforms[transforms.length - 1]!;
  const chunks: Buffer[] = [];
  // The pipeline call consumed the stream; we need to collect differently.
  // Instead, collect by streaming through manually.
  return Buffer.from(""); // placeholder — see collectViaManual
}

/** Stream source through transforms and collect output. */
async function drainTransforms(source: Buffer, ...transforms: NodeJS.ReadWriteStream[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const last = transforms[transforms.length - 1]!;
  last.on("data", (chunk: Buffer) => chunks.push(chunk));

  const readable = Readable.from(source);
  await new Promise<void>((resolve, reject) => {
    let current: NodeJS.ReadWriteStream | Readable = readable;
    for (const t of transforms) {
      current = (current as Readable).pipe(t as unknown as NodeJS.WritableStream) as unknown as Readable;
    }
    last.on("end", resolve);
    last.on("error", reject);
    readable.on("error", reject);
  });
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// makeByteCounter
// ---------------------------------------------------------------------------

describe("makeByteCounter", () => {
  it("passes chunks through when under cap", async () => {
    const data = Buffer.alloc(100, 0x41); // 100 bytes of 'A'
    const counter = makeByteCounter(200, FetchErrorCode.RESPONSE_TOO_LARGE);
    const result = await drainTransforms(data, counter);
    expect(result.length).toBe(100);
  });

  it("errors with RESPONSE_TOO_LARGE when cap exceeded (identity body)", async () => {
    const data = Buffer.alloc(100, 0x41);
    const counter = makeByteCounter(99, FetchErrorCode.RESPONSE_TOO_LARGE);

    await expect(drainTransforms(data, counter)).rejects.toMatchObject({
      code: FetchErrorCode.RESPONSE_TOO_LARGE,
    });
  });

  it("errors with DECOMPRESSION_BOMB code when that code passed", async () => {
    const data = Buffer.alloc(50, 0x41);
    const counter = makeByteCounter(10, FetchErrorCode.DECOMPRESSION_BOMB);

    await expect(drainTransforms(data, counter)).rejects.toMatchObject({
      code: FetchErrorCode.DECOMPRESSION_BOMB,
    });
  });
});

// ---------------------------------------------------------------------------
// buildDecompressChain
// ---------------------------------------------------------------------------

describe("buildDecompressChain", () => {
  it("returns empty array for null (identity)", () => {
    const chain = buildDecompressChain(null, 1_000_000);
    expect(chain).toHaveLength(0);
  });

  it("returns empty array for 'identity' encoding", () => {
    const chain = buildDecompressChain("identity", 1_000_000);
    expect(chain).toHaveLength(0);
  });

  it("decompresses single gzip payload under cap correctly", async () => {
    const original = Buffer.from("hello world");
    const compressed = gzipSync(original);

    const chain = buildDecompressChain("gzip", 1_000_000);
    expect(chain.length).toBeGreaterThanOrEqual(1);

    const result = await drainTransforms(compressed, ...chain);
    expect(result.toString()).toBe("hello world");
  });

  it("decompresses x-gzip (alias for gzip)", async () => {
    const original = Buffer.from("x-gzip test");
    const compressed = gzipSync(original);

    const chain = buildDecompressChain("x-gzip", 1_000_000);
    const result = await drainTransforms(compressed, ...chain);
    expect(result.toString()).toBe("x-gzip test");
  });

  it("throws DECOMPRESSION_BOMB for high-ratio gzip bomb (cap small)", async () => {
    // 10KB of zeros compressed — ratio is very high
    const largeData = Buffer.alloc(10_000, 0x00);
    const compressed = gzipSync(largeData);

    // Cap at 100 bytes — decompressed bytes will exceed this
    const chain = buildDecompressChain("gzip", 100);
    await expect(drainTransforms(compressed, ...chain)).rejects.toMatchObject({
      code: FetchErrorCode.DECOMPRESSION_BOMB,
    });
  });

  it("throws DECOMPRESSION_BOMB for stacked encoding > 2 layers", () => {
    expect(() => buildDecompressChain("gzip, gzip, gzip", 1_000_000)).toThrow(
      expect.objectContaining({ code: FetchErrorCode.DECOMPRESSION_BOMB }),
    );
  });

  it("allows exactly 2 stacked encodings", async () => {
    // gzip,gzip = 2 layers (valid)
    const inner = Buffer.from("double compressed");
    const layer1 = gzipSync(inner);
    const layer2 = gzipSync(layer1);

    // Content-Encoding is applied in reverse order: last encoding first
    // "gzip, gzip" means: outer gzip (applied first), inner gzip (applied second)
    const chain = buildDecompressChain("gzip, gzip", 1_000_000);
    expect(chain.length).toBeGreaterThanOrEqual(2);

    const result = await drainTransforms(layer2, ...chain);
    expect(result.toString()).toBe("double compressed");
  });

  it("throws FETCH_ERROR for unknown encoding", () => {
    expect(() => buildDecompressChain("zstd", 1_000_000)).toThrow(
      expect.objectContaining({ code: FetchErrorCode.FETCH_ERROR }),
    );
  });

  it("counter is placed AFTER decompressor (cap is on decompressed bytes)", async () => {
    // compressed ~= small; decompressed ~= large
    const largeData = Buffer.alloc(5_000, 0x41);
    const compressed = gzipSync(largeData);

    // Cap at 4999 (below decompressed size, above compressed size)
    const chain = buildDecompressChain("gzip", 4_999);
    await expect(drainTransforms(compressed, ...chain)).rejects.toMatchObject({
      code: FetchErrorCode.DECOMPRESSION_BOMB,
    });
  });
});
