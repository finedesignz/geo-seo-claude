/**
 * POST /audit — validate, normalize, consumer-scoped dedup, callback SSRF, insert
 * (API-01 / API-04 / API-08).
 *
 * Real PGlite DAL (no DAL mock) + real createApp. SSRF uses a mock resolver
 * (loopback) so private-IP rejection is exercised without real network.
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
const loopbackResolver: CallbackResolver = async () => ["127.0.0.1"];

const HOW = { Authorization: "Bearer sk-how", "Content-Type": "application/json" };
const OTTO = { Authorization: "Bearer sk-otto", "Content-Type": "application/json" };

function build(test: TestDal, resolver: CallbackResolver = publicResolver) {
  return createApp({
    dal: test.dal,
    fetcher: createSafeFetcher({ resolver: publicResolver }),
    apiKeys: KEYS,
    callbackResolver: resolver,
  });
}

function hashOf(url: string): string {
  const { url: normalized } = normalizeUrl(url);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

async function post(app: ReturnType<typeof createApp>, headers: Record<string, string>, body: unknown) {
  return app.request("/audit", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /audit", () => {
  let test: TestDal;

  afterEach(async () => {
    if (test) await test.db.close();
  });

  it("happy path → 200 {job_id}, row persisted with consumer_id", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await post(app, HOW, { url: "https://example.com" });
    expect(res.status).toBe(200);
    const { job_id } = (await res.json()) as { job_id: string };
    expect(job_id).toBeTruthy();
    const job = await test.dal.getJob(job_id);
    expect(job?.consumerId).toBe("how");
    expect(job?.status).toBe("queued");
  });

  it("invalid (non-http) url → 400", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await post(app, HOW, { url: "not-a-url" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("malformed body (missing url) → 400", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await post(app, HOW, { foo: "bar" });
    expect(res.status).toBe(400);
  });

  it("same-consumer repeat within TTL → SAME job_id, no new row", async () => {
    test = await makeTestDal();
    const app = build(test);
    const first = (await (await post(app, HOW, { url: "https://example.com" })).json()) as { job_id: string };
    const second = (await (await post(app, HOW, { url: "https://example.com" })).json()) as { job_id: string };
    expect(second.job_id).toBe(first.job_id);
    const jobs = await test.dal.listJobs({ consumerId: "how", limit: 10, offset: 0 });
    expect(jobs.length).toBe(1);
  });

  it("different consumer, same url → NEW job_id (consumer-scoped, no cross-consumer dedup)", async () => {
    test = await makeTestDal();
    const app = build(test);
    const how = (await (await post(app, HOW, { url: "https://example.com" })).json()) as { job_id: string };
    const otto = (await (await post(app, OTTO, { url: "https://example.com" })).json()) as { job_id: string };
    expect(otto.job_id).not.toBe(how.job_id);
    const ottoJob = await test.dal.getJob(otto.job_id);
    expect(ottoJob?.consumerId).toBe("ottolax");
  });

  it("prior FAILED job does NOT dedup → new job_id (re-enqueue)", async () => {
    test = await makeTestDal();
    const url = "https://example.com";
    const seeded = await test.dal.insertJob({
      url,
      normalizedUrl: normalizeUrl(url).url,
      urlHash: hashOf(url),
      consumerId: "how",
    });
    // Move the seeded job to failed via the lifecycle (claim → fail).
    const claimed = await test.dal.claimNextJob();
    expect(claimed?.id).toBe(seeded.id);
    await test.dal.failJob(claimed!.id, claimed!.leaseToken!, "boom");

    const app = build(test);
    const res = await post(app, HOW, { url });
    expect(res.status).toBe(200);
    const { job_id } = (await res.json()) as { job_id: string };
    expect(job_id).not.toBe(seeded.id);
  });

  it("callback_url resolving to loopback → 400 ssrf_blocked, no insert", async () => {
    test = await makeTestDal();
    const app = build(test, loopbackResolver);
    const res = await post(app, HOW, { url: "https://example.com", callback_url: "https://hook.example.com/cb" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ssrf_blocked");
    const jobs = await test.dal.listJobs({ consumerId: "how", limit: 10, offset: 0 });
    expect(jobs.length).toBe(0);
  });

  it("public callback_url → accepted, persisted on the job", async () => {
    test = await makeTestDal();
    const app = build(test, publicResolver);
    const res = await post(app, HOW, {
      url: "https://example.com",
      callback_url: "https://hook.example.com/cb",
    });
    expect(res.status).toBe(200);
    const { job_id } = (await res.json()) as { job_id: string };
    const job = await test.dal.getJob(job_id);
    expect(job?.callbackUrl).toBe("https://hook.example.com/cb");
  });

  it("route is registered in /openapi.json", async () => {
    test = await makeTestDal();
    const app = build(test);
    const doc = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/audit"]).toBeDefined();
  });
});
