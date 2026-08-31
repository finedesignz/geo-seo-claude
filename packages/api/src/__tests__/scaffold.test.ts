/**
 * Wave 0 scaffold test: createApp factory + rule-21 docs surface.
 *
 * Uses a real PGlite DAL (no DAL mocking) + a mock-resolver SSRF fetcher.
 * Asserts /openapi.json is a parseable OpenAPI 3.1 doc and /docs returns 200.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSafeFetcher } from "@geo/fetch";
import { createApp } from "../app.js";
import { makeTestDal } from "./pglite-helper.js";
import type { TestDal } from "./pglite-helper.js";

const mockResolver = async (_host: string): Promise<string[]> => ["8.8.8.8"];

describe("@geo/api scaffold", () => {
  let test: TestDal;

  afterEach(async () => {
    if (test) await test.db.close();
  });

  it("/openapi.json returns a parseable OpenAPI 3.1 document", async () => {
    test = await makeTestDal();
    const app = createApp({
      dal: test.dal,
      fetcher: createSafeFetcher({ resolver: mockResolver }),
      apiKeys: new Map([["sk-test", "test-consumer"]]),
      callbackResolver: mockResolver,
    });

    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);

    const doc = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths).toBeTypeOf("object");
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(0);
  });

  it("/docs returns 200", async () => {
    test = await makeTestDal();
    const app = createApp({
      dal: test.dal,
      fetcher: createSafeFetcher({ resolver: mockResolver }),
      apiKeys: new Map([["sk-test", "test-consumer"]]),
      callbackResolver: mockResolver,
    });

    const res = await app.request("/docs");
    expect(res.status).toBe(200);
  });
});
