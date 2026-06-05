/**
 * bearerAuth middleware + parseApiKeys (API-05, D-03).
 *
 * Real PGlite DAL (no DAL mock), real createApp. Exercises 401 semantics on a
 * protected route, exemptions, consumer_id attachment, and parse robustness.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSafeFetcher } from "@geo/fetch";
import { createApp } from "../app.js";
import { parseApiKeys, bearerAuth, EXEMPT } from "../middleware/auth.js";
import { makeTestDal } from "./pglite-helper.js";
import type { TestDal } from "./pglite-helper.js";

const publicResolver = async (_host: string): Promise<string[]> => ["8.8.8.8"];

function build(test: TestDal, apiKeys: Map<string, string>) {
  return createApp({
    dal: test.dal,
    fetcher: createSafeFetcher({ resolver: publicResolver }),
    apiKeys,
    callbackResolver: publicResolver,
  });
}

describe("parseApiKeys", () => {
  it("throws on undefined (fail-fast)", () => {
    expect(() => parseApiKeys(undefined)).toThrow(/GEO_API_KEYS/);
  });

  it("throws on empty string", () => {
    expect(() => parseApiKeys("")).toThrow(/GEO_API_KEYS/);
  });

  it("throws when nothing parses to a pair", () => {
    expect(() => parseApiKeys("nopairshere")).toThrow(/empty map/);
  });

  it("parses two pairs", () => {
    const m = parseApiKeys("a:x,b:y");
    expect(m.size).toBe(2);
    expect(m.get("a")).toBe("x");
    expect(m.get("b")).toBe("y");
  });

  it("splits on the FIRST colon so tokens containing ':' survive", () => {
    const m = parseApiKeys("sk:live:abc123:how");
    expect(m.get("sk")).toBe("live:abc123:how");
  });

  it("tolerates a ',' inside a token via backslash escape", () => {
    const m = parseApiKeys("tok\\,en:how,plain:ottolax");
    expect(m.get("tok,en")).toBe("how");
    expect(m.get("plain")).toBe("ottolax");
  });
});

describe("bearerAuth", () => {
  let test: TestDal;
  const keys = parseApiKeys("sk-how:how,sk-otto:ottolax");

  afterEach(async () => {
    if (test) await test.db.close();
  });

  it("401 + WWW-Authenticate on missing Authorization for a protected route", async () => {
    test = await makeTestDal();
    const app = build(test, keys);
    const res = await app.request("/audit", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("401 on a token not in GEO_API_KEYS", async () => {
    test = await makeTestDal();
    const app = build(test, keys);
    const res = await app.request("/audit", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-key", "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("does NOT throw on a token of a different length than any key (length-safe compare)", async () => {
    test = await makeTestDal();
    const app = build(test, keys);
    const res = await app.request("/audit", {
      method: "POST",
      headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid token (case-insensitive bearer) and submits", async () => {
    test = await makeTestDal();
    const app = build(test, keys);
    const res = await app.request("/audit", {
      method: "POST",
      headers: { Authorization: "bearer sk-how", "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(200);
  });

  it("attaches the mapped consumer_id (job persisted with consumer_id)", async () => {
    test = await makeTestDal();
    const app = build(test, keys);
    const res = await app.request("/audit", {
      method: "POST",
      headers: { Authorization: "Bearer sk-otto", "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const { job_id } = (await res.json()) as { job_id: string };
    const job = await test.dal.getJob(job_id);
    expect(job?.consumerId).toBe("ottolax");
  });

  it("exempt paths are reachable WITHOUT a token", async () => {
    test = await makeTestDal();
    const app = build(test, keys);
    for (const path of EXEMPT) {
      const res = await app.request(path);
      expect(res.status, `${path} should be tokenless-reachable`).toBe(200);
    }
  });
});
