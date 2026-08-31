/**
 * @geo/cron DEPLOY-02 in-process test (Task 2).
 *
 * Drives the pure runCron loop against the REAL in-process @geo/api Hono app
 * (createApp) backed by a real PGlite DAL (Phase-5 harness) — no DAL mock, no
 * network. The cron fetchImpl is `app.request`, so the POST /audit goes straight
 * into the app and lands a row in PGlite scoped to the `cron` consumer.
 *
 * Secret safety: the bearer token here ("cron-token") is a clearly-fixture value
 * and the DB is in-memory PGlite — never a prod token or prod DATABASE_URL.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSafeFetcher } from "@geo/fetch";
// createApp / parseApiKeys are NOT in the @geo/api barrel — relative-path import
// (same pattern pglite-helper uses to reach @geo/db source).
import { createApp } from "../../../api/src/app.js";
import { parseApiKeys } from "../../../api/src/middleware/auth.js";
import { makeTestDal } from "../../../api/src/__tests__/pglite-helper.js";
import type { TestDal } from "../../../api/src/__tests__/pglite-helper.js";
import type { CallbackResolver } from "../../../api/src/app.js";
import { runCron } from "../cron.js";

const publicResolver: CallbackResolver = async () => ["8.8.8.8"];

function build(test: TestDal) {
  // Dedicated low-privilege `cron` consumer (D-4).
  const apiKeys = parseApiKeys("cron-token:cron");
  return createApp({
    dal: test.dal,
    fetcher: createSafeFetcher({ resolver: publicResolver }),
    apiKeys,
    callbackResolver: publicResolver,
  });
}

function makeFetchImpl(app: ReturnType<typeof createApp>): typeof fetch {
  // baseUrl is "" so the POST path is exactly "/audit"; Hono resolves the route.
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(input as string, init as RequestInit)) as typeof fetch;
}

describe("DEPLOY-02: cron enqueues audits scoped to the `cron` consumer", () => {
  let test: TestDal;

  afterEach(async () => {
    if (test) await test.db.close();
  });

  it("POSTs /audit per URL; each job persists with consumerId === 'cron'", async () => {
    test = await makeTestDal();
    const app = build(test);
    const urls = ["https://a.example", "https://b.example"];

    const summary = await runCron({
      baseUrl: "",
      token: "cron-token",
      urls,
      fetchImpl: makeFetchImpl(app),
    });

    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.results.every((r) => r.ok && r.jobId)).toBe(true);

    for (const r of summary.results) {
      const job = await test.dal.getJob(r.jobId!);
      expect(job?.consumerId).toBe("cron");
      expect(job?.status).toBe("queued");
    }

    // History is scoped to the cron consumer.
    const jobs = await test.dal.listJobs({ consumerId: "cron", limit: 10, offset: 0 });
    expect(jobs.length).toBe(2);
  });

  it("a failing URL (app rejects → 400) does NOT abort the remaining URLs", async () => {
    test = await makeTestDal();
    const app = build(test);
    // "not-a-url" is rejected by the API (400); the two good URLs still enqueue.
    const urls = ["https://good-a.example", "not-a-url", "https://good-b.example"];

    const summary = await runCron({
      baseUrl: "",
      token: "cron-token",
      urls,
      fetchImpl: makeFetchImpl(app),
    });

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);

    const bad = summary.results.find((r) => r.url === "not-a-url");
    expect(bad?.ok).toBe(false);
    expect(bad?.status).toBe(400);
    expect(bad?.error).toBe("http_400");

    const good = summary.results.filter((r) => r.ok);
    expect(good.map((r) => r.url).sort()).toEqual([
      "https://good-a.example",
      "https://good-b.example",
    ]);

    // Only the 2 good URLs landed as jobs.
    const jobs = await test.dal.listJobs({ consumerId: "cron", limit: 10, offset: 0 });
    expect(jobs.length).toBe(2);
  });

  it("an unauthorized token yields http_401 for every URL but never throws", async () => {
    test = await makeTestDal();
    const app = build(test);

    const summary = await runCron({
      baseUrl: "",
      token: "wrong-token",
      urls: ["https://a.example"],
      fetchImpl: makeFetchImpl(app),
    });

    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.status).toBe(401);
    expect(summary.results[0]?.error).toBe("http_401");

    const jobs = await test.dal.listJobs({ consumerId: "cron", limit: 10, offset: 0 });
    expect(jobs.length).toBe(0);
  });

  it("a thrown fetch error is captured and the loop continues", async () => {
    test = await makeTestDal();
    let calls = 0;
    const flaky: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("boom"));
      const app = build(test);
      return app.request(input as string, init as RequestInit);
    }) as typeof fetch;

    const summary = await runCron({
      baseUrl: "",
      token: "cron-token",
      urls: ["https://first.example", "https://second.example"],
      fetchImpl: flaky,
    });

    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.results[0]?.ok).toBe(false);
    expect(summary.results[0]?.error).toContain("boom");
    expect(summary.results[1]?.ok).toBe(true);
  });
});
