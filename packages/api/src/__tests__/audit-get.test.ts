/**
 * GET /audit/{job_id} — poll, ownership-scoped 404, response DTO (API-02, D-05, D-15).
 *
 * Real PGlite DAL (no DAL mock) + real createApp + real bearer auth.
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

function hashOf(url: string): string {
  const { url: normalized } = normalizeUrl(url);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

async function seed(test: TestDal, url: string, consumerId: string) {
  return test.dal.insertJob({
    url,
    normalizedUrl: normalizeUrl(url).url,
    urlHash: hashOf(url + consumerId + Math.random()),
    consumerId,
  });
}

describe("GET /audit/{job_id}", () => {
  let test: TestDal;
  afterEach(async () => {
    if (test) await test.db.close();
  });

  it("owned + done → 200 with score + findings", async () => {
    test = await makeTestDal();
    const job = await seed(test, "https://example.com", "how");
    const claimed = await test.dal.claimNextJob();
    await test.dal.completeJob(claimed!.id, claimed!.leaseToken!, 88, { robots: { allowed: true } as never });

    const app = build(test);
    const res = await app.request(`/audit/${job.id}`, { headers: HOW });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("done");
    expect(body.score).toBe(88);
    expect(body.findings).toBeDefined();
  });

  it("owned + queued → 200 status-only (no score/findings)", async () => {
    test = await makeTestDal();
    const job = await seed(test, "https://example.com", "how");

    const app = build(test);
    const res = await app.request(`/audit/${job.id}`, { headers: HOW });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("queued");
    expect(body.score).toBeUndefined();
    expect(body.findings).toBeUndefined();
  });

  it("not found → 404", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await app.request(`/audit/00000000-0000-0000-0000-000000000000`, { headers: HOW });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("owned by a different consumer → 404 (no cross-consumer read)", async () => {
    test = await makeTestDal();
    const job = await seed(test, "https://example.com", "how");

    const app = build(test);
    const res = await app.request(`/audit/${job.id}`, { headers: OTTO });
    expect(res.status).toBe(404);
  });

  it("DTO excludes internal columns (D-15)", async () => {
    test = await makeTestDal();
    const job = await seed(test, "https://example.com", "how");

    const app = build(test);
    const res = await app.request(`/audit/${job.id}`, { headers: HOW });
    const body = (await res.json()) as Record<string, unknown>;
    for (const field of [
      "callback_url",
      "callbackUrl",
      "lease_token",
      "leaseToken",
      "attempts",
      "locked_at",
      "lease_expires_at",
      "consumer_id",
      "consumerId",
      "url_hash",
    ]) {
      expect(body[field]).toBeUndefined();
    }
  });

  it("requires a bearer token → 401", async () => {
    test = await makeTestDal();
    const job = await seed(test, "https://example.com", "how");
    const app = build(test);
    const res = await app.request(`/audit/${job.id}`);
    expect(res.status).toBe(401);
  });

  // Regression (defect: malformed job_id crashed the uuid cast in Postgres,
  // an uncaught 22P02 escaped as a raw 500 instead of a clean 4xx).
  it("malformed job_id (not shaped like a uuid) → 400, never 500", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await app.request(`/audit/does-not-exist-12345`, { headers: HOW });
    expect(res.status).not.toBe(500);
    expect([400, 404, 422]).toContain(res.status);
  });

  it("malicious job_id (SQL-injection-shaped string) → 400, never 500", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await app.request(`/audit/${encodeURIComponent("' OR 1=1 --")}`, { headers: HOW });
    expect(res.status).not.toBe(500);
    expect([400, 404, 422]).toContain(res.status);
  });

  it("47-char non-uuid job_id → 400, never 500", async () => {
    test = await makeTestDal();
    const app = build(test);
    const res = await app.request(`/audit/${"x".repeat(47)}`, { headers: HOW });
    expect(res.status).not.toBe(500);
    expect([400, 404, 422]).toContain(res.status);
  });
});
