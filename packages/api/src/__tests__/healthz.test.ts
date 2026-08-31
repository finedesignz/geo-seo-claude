/**
 * GET /healthz — deep DB check, 200/503, public (API-06, D-07).
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

describe("GET /healthz", () => {
  let test: TestDal;
  afterEach(async () => {
    if (test) {
      try {
        await test.db.close();
      } catch {
        /* already closed by a test */
      }
    }
  });

  it("DB reachable → 200 { status:'ok', db:'ok' }, no token required", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await app.request(`/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string };
    expect(body).toEqual({ status: "ok", db: "ok" });
  });

  it("DB down (closed) → 503 { status:'error', db:'error' }", async () => {
    test = await makeTestDal();
    const app = build(test);
    // Close the underlying PGlite db so the SELECT 1 throws.
    await test.db.close();

    const res = await app.request(`/healthz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; db: string };
    expect(body).toEqual({ status: "error", db: "error" });
  });
});
