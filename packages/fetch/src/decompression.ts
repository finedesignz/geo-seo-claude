/**
 * @geo/fetch — decompression pipeline with byte-counting (SEC-04)
 *
 * makeByteCounter: a Transform that sums chunk byte lengths and errors
 * with a structured code once the running total exceeds maxBytes.
 *
 * buildDecompressChain: returns an ordered array of decompressor Transforms
 * for the given Content-Encoding value, each followed by a counting Transform
 * after the final decompressor (cap is on DECOMPRESSED bytes).
 * Rejects > 2 stacked encodings with DECOMPRESSION_BOMB.
 * Unknown encodings reject with FETCH_ERROR.
 */

import {
  createGunzip,
  createInflate,
  createBrotliDecompress,
} from "node:zlib";
import { Transform } from "node:stream";
import { FetchErrorCode } from "./errors.js";

// ---------------------------------------------------------------------------
// makeByteCounter
// ---------------------------------------------------------------------------

/**
 * Returns a passthrough Transform that sums byte lengths of all chunks.
 * When the running total exceeds maxBytes, it destroys itself with an error
 * that has `.code = errorCode`.
 */
export function makeByteCounter(
  maxBytes: number,
  errorCode: typeof FetchErrorCode.RESPONSE_TOO_LARGE | typeof FetchErrorCode.DECOMPRESSION_BOMB,
): Transform {
  let total = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error(
          `Response exceeded ${maxBytes} bytes (${errorCode})`,
        ) as NodeJS.ErrnoException & { code: string };
        err.code = errorCode;
        callback(err);
        return;
      }
      callback(null, chunk);
    },
  });
}

// ---------------------------------------------------------------------------
// buildDecompressChain
// ---------------------------------------------------------------------------

/**
 * Parses a Content-Encoding header value and returns the pipeline of
 * Transform stages needed to decompress the body.
 *
 * Rules:
 * - null / "identity" → empty array (no decompression needed).
 * - > 2 comma-separated encodings → throw with .code = DECOMPRESSION_BOMB.
 * - Supported: gzip, x-gzip (→ createGunzip), deflate (→ createInflate),
 *   br (→ createBrotliDecompress).
 * - Unknown encoding → throw with .code = FETCH_ERROR.
 * - The byte counter (DECOMPRESSION_BOMB) is appended AFTER the last
 *   decompressor so the cap applies to DECOMPRESSED bytes.
 *
 * NOTE: Content-Encoding is listed in the order they were applied, so the
 * outermost encoding is last in the list and must be decoded first.
 * e.g. "gzip, br" means: br was applied first, then gzip — so decode
 * gzip first (reverse order from header).
 * RFC 7231 §3.1.2.2: codings are listed in applied order; decode in reverse.
 */
export function buildDecompressChain(
  contentEncoding: string | null,
  maxBytes: number,
): NodeJS.ReadWriteStream[] {
  if (!contentEncoding || contentEncoding.trim().toLowerCase() === "identity") {
    return [];
  }

  const encodings = contentEncoding
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "" && e !== "identity");

  if (encodings.length === 0) {
    return [];
  }

  // Cap stacked encodings at 2
  if (encodings.length > 2) {
    const err = new Error(
      `Too many Content-Encoding layers (${encodings.length}): ${contentEncoding}`,
    ) as Error & { code: string };
    err.code = FetchErrorCode.DECOMPRESSION_BOMB;
    throw err;
  }

  // Validate all encodings before building transforms
  for (const enc of encodings) {
    if (!["gzip", "x-gzip", "deflate", "br"].includes(enc)) {
      const err = new Error(
        `Unsupported Content-Encoding: ${enc}`,
      ) as Error & { code: string };
      err.code = FetchErrorCode.FETCH_ERROR;
      throw err;
    }
  }

  // Build decompressor stages in REVERSE order (outermost encoding decoded first)
  // RFC 7231: encodings listed in application order, decode in reverse
  const reversed = [...encodings].reverse();

  const decompressors: NodeJS.ReadWriteStream[] = reversed.map((enc) => {
    switch (enc) {
      case "gzip":
      case "x-gzip":
        return createGunzip();
      case "deflate":
        return createInflate();
      case "br":
        return createBrotliDecompress();
      default:
        // Already validated above, unreachable
        throw new Error(`Unexpected encoding: ${enc}`);
    }
  });

  // Append a byte counter AFTER the last decompressor (counts decompressed bytes)
  const counter = makeByteCounter(maxBytes, FetchErrorCode.DECOMPRESSION_BOMB);
  decompressors.push(counter);

  return decompressors;
}
