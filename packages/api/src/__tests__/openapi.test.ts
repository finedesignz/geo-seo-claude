/**
 * /openapi.json + /docs surface (API-07, D-02).
 *
 * Asserts the generated spec is OpenAPI 3.x, carries the BearerAuth security
 * scheme, lists all four route paths, and that /docs (Scalar) returns 200.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSafeFetcher } from "@geo/fetch";
import { createApp } from "../app.js";
import { parseApiKeys } from "../middleware/auth.js";
import { makeTestDal } from "./pglite-helper.js";
import type { TestDal } from "./pglite-helper.js";
import type { CallbackResolver } from "../app.js";

const KEYS = parseApiKeys("sk-how:how");
const publicResolver: CallbackResolver = async () => ["8.8.8.8"];

function build(test: TestDal) {
  return createApp({
    dal: test.dal,
    fetcher: createSafeFetcher({ resolver: publicResolver }),
    apiKeys: KEYS,
    callbackResolver: publicResolver,
  });
}

describe("/openapi.json + /docs", () => {
  let test: TestDal;
  afterEach(async () => {
    if (test) await test.db.close();
  });

  it("/openapi.json is a valid OpenAPI 3.x doc", async () => {
    test = await makeTestDal();
    const app = build(test);
    const doc = (await (await app.request("/openapi.json")).json()) as { openapi: string };
    expect(typeof doc.openapi).toBe("string");
    expect(doc.openapi.startsWith("3.")).toBe(true);
  });

  it("declares components.securitySchemes.BearerAuth (http/bearer)", async () => {
    test = await makeTestDal();
    const app = build(test);
    const doc = (await (await app.request("/openapi.json")).json()) as {
      components?: { securitySchemes?: Record<string, { type: string; scheme: string }> };
    };
    const scheme = doc.components?.securitySchemes?.BearerAuth;
    expect(scheme).toBeDefined();
    expect(scheme!.type).toBe("http");
    expect(scheme!.scheme).toBe("bearer");
  });

  it("lists all four route paths", async () => {
    test = await makeTestDal();
    const app = build(test);
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    expect(doc.paths["/audit"]).toBeDefined();
    expect(doc.paths["/audit/{job_id}"]).toBeDefined();
    expect(doc.paths["/audits"]).toBeDefined();
    expect(doc.paths["/healthz"]).toBeDefined();
  });

  it("/docs returns 200 (Scalar)", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
  });
});
