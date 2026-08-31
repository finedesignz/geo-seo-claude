/**
 * GET /audits — paginated, consumer-scoped, response DTO (API-03, D-06, D-15).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSafeFetcher } from "@geo/fetch";
import { normalizeUrl } from "@geo/core";
import { createHash } from "node:crypto";
import { createApp } from "../app.js";
import { parseApiKeys } from "../middleware/auth.js";
import { makeTestDal } from "./pglite-helper.js";
import type { TestDal } from "./pglite-helper.js";
import type { CallbackResolver } from "../app.js";

const KEYS = parseApiKeys("sk-how:how,sk-otto:ottolax");
const publicResolver: CallbackResolver = async () => ["8.8.8.8"];
const HOW = { Authorization: "Bearer sk-how" };
const OTTO = { Authorization: "Bearer sk-otto" };

function build(test: TestDal) {
  return createApp({
    dal: test.dal,
    fetcher: createSafeFetcher({ resolver: publicResolver }),
    apiKeys: KEYS,
    callbackResolver: publicResolver,
  });
}

async function seed(test: TestDal, url: string, consumerId: string) {
  return test.dal.insertJob({
    url,
    normalizedUrl: normalizeUrl(url).url,
    urlHash: createHash("sha256").update(url + consumerId + Math.random(), "utf8").digest("hex"),
    consumerId,
  });
}

describe("GET /audits", () => {
  let test: TestDal;
  afterEach(async () => {
    if (test) await test.db.close();
  });

  it("returns only the authenticated consumer's jobs (consumer scoping)", async () => {
    test = await makeTestDal();
    await seed(test, "https://how-1.com", "how");
    await seed(test, "https://how-2.com", "how");
    await seed(test, "https://otto-1.com", "ottolax");

    const app = build(test);
    const res = await app.request(`/audits`, { headers: HOW });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: { url: string }[]; page: number; limit: number };
    expect(body.jobs.length).toBe(2);
    expect(body.jobs.every((j) => j.url.includes("how-"))).toBe(true);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  it("paginates: page/limit coerced from query, second page disjoint", async () => {
    test = await makeTestDal();
    for (let i = 0; i < 5; i++) await seed(test, `https://how-${i}.com`, "how");

    const app = build(test);
    const p1 = (await (await app.request(`/audits?page=1&limit=2`, { headers: HOW })).json()) as {
      jobs: { job_id: string }[];
      page: number;
      limit: number;
    };
    const p2 = (await (await app.request(`/audits?page=2&limit=2`, { headers: HOW })).json()) as {
      jobs: { job_id: string }[];
    };
    expect(p1.jobs.length).toBe(2);
    expect(p1.page).toBe(1);
    expect(p1.limit).toBe(2);
    expect(p2.jobs.length).toBe(2);
    const ids1 = new Set(p1.jobs.map((j) => j.job_id));
    expect(p2.jobs.some((j) => ids1.has(j.job_id))).toBe(false);
  });

  it("limit is capped at 100 (over-cap → 400 from zod max)", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await app.request(`/audits?limit=1000`, { headers: HOW });
    // zod .max(100) rejects an over-cap value with a 400.
    expect(res.status).toBe(400);
  });

  it("response items contain ONLY DTO fields, no internal columns (D-15)", async () => {
    test = await makeTestDal();
    await test.dal.insertJob({
      url: "https://example.com",
      normalizedUrl: "https://example.com",
      urlHash: createHash("sha256").update("dto", "utf8").digest("hex"),
      callbackUrl: "https://hook.example.com/cb",
      consumerId: "how",
    });

    const app = build(test);
    const body = (await (await app.request(`/audits`, { headers: HOW })).json()) as {
      jobs: Record<string, unknown>[];
    };
    const item = body.jobs[0]!;
    expect(Object.keys(item).sort()).toEqual(["created_at", "job_id", "status", "url"]);
    for (const field of [
      "callback_url",
      "callbackUrl",
      "lease_token",
      "leaseToken",
      "attempts",
      "consumer_id",
      "consumerId",
      "url_hash",
    ]) {
      expect(item[field]).toBeUndefined();
    }
  });

  it("requires a bearer token → 401", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await app.request(`/audits`);
    expect(res.status).toBe(401);
  });
});
