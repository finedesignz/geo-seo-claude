/**
 * webhook.test.ts — deliverWebhook + pipeline wiring (API-08, D-08/D-12).
 *
 * WH-01: POSTs the payload on a public host (capturing requester).
 * WH-02: a callbackUrl resolving to a private IP at fire time is BLOCKED and
 *        deliverWebhook does NOT throw — uses the REAL createSafeRequester with
 *        a loopback resolver (SSRF semantics are NOT mocked).
 * WH-03: a failing requester is swallowed (non-fatal).
 * WH-04: pipeline fires the webhook on completion when callbackUrl is present,
 *        and does NOT fire when absent; a failing delivery never fails the job.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { createSafeRequester } from "@geo/fetch";
import type { FetchResult } from "@geo/core";
import { createStaticResolver } from "../../../fetch/test/helpers/mock-resolver.js";
import { makePgliteDb } from "../../../db/src/__tests__/harness.js";
import { runMigrations } from "../../../db/src/migrate.js";
import { createAuditDal } from "../../../db/src/dal.js";
import { makePgliteExecutor } from "../../../db/src/__tests__/pglite-executor.js";
import type { Fetcher } from "@geo/core";
import { deliverWebhook } from "../webhook.js";
import type { WebhookRequester } from "../webhook.js";
import { runAudit } from "../pipeline.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../../../packages/db/migrations");
const LEASE_TTL = 120;
const MAX_ATTEMPTS = 3;

function okResult(url: string): FetchResult {
  return { url, status: 200, headers: {}, body: "ok", redirectChain: [] };
}
function errResult(url: string, error = "FETCH_ERROR"): FetchResult {
  return { url, status: 0, headers: {}, body: "", redirectChain: [], error };
}

function okFetcher(body = "<html>hi</html>"): Fetcher {
  return async (url: string) => ({ url, status: 200, headers: { "content-type": "text/html" }, body, redirectChain: [] });
}

describe("deliverWebhook", () => {
  it("WH-01: POSTs the payload to a public host (capturing requester)", async () => {
    const calls: { url: string; body?: string }[] = [];
    const requester: WebhookRequester = async (url, input) => {
      calls.push({ url, body: input.body });
      return okResult(url);
    };

    await deliverWebhook(
      "https://hook.example.com/cb",
      { job_id: "j1", status: "done", score: 88, findings: { a: 1 } },
      { requester },
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://hook.example.com/cb");
    const parsed = JSON.parse(calls[0]!.body!) as { job_id: string; status: string; score: number };
    expect(parsed).toMatchObject({ job_id: "j1", status: "done", score: 88 });
  });

  it("WH-02: private-resolving host blocked at fire time, does NOT throw (real requester)", async () => {
    // REAL createSafeRequester (no SSRF mock) + loopback resolver → the host is
    // re-classified at fire time and the POST is blocked before any connection.
    const requester = createSafeRequester({
      resolver: createStaticResolver(["127.0.0.1"]),
    });

    await expect(
      deliverWebhook(
        "https://attacker.test/cb",
        { job_id: "j2", status: "done", score: 50, findings: null },
        { requester },
      ),
    ).resolves.toBeUndefined();
  });

  it("WH-03: a failing requester is swallowed (non-fatal, retries then returns)", async () => {
    let attempts = 0;
    const requester: WebhookRequester = async (url) => {
      attempts++;
      return errResult(url, "FETCH_ERROR");
    };

    await expect(
      deliverWebhook(
        "https://hook.example.com/cb",
        { job_id: "j3", status: "done", score: 1, findings: null },
        { requester, maxRetries: 2 },
      ),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3); // 1 + 2 retries
  });

  it("WH-03b: a throwing requester is swallowed (never rejects)", async () => {
    const requester: WebhookRequester = async () => {
      throw new Error("boom");
    };
    await expect(
      deliverWebhook("https://hook.example.com/cb", { job_id: "j4", status: "done", score: 1, findings: null }, { requester }),
    ).resolves.toBeUndefined();
  });
});

describe("pipeline webhook wiring (API-08)", () => {
  async function setup() {
    const db = await makePgliteDb();
    await runMigrations(db, MIGRATIONS_DIR);
    const dal = createAuditDal(makePgliteExecutor(db));
    return { db, dal };
  }

  function scorer(score = 72) {
    return { score: vi.fn(async () => ({ score, findings: { crawlability: { points: 18 } } })) };
  }

  it("WH-04a: fires the webhook on completion when callbackUrl is present", async () => {
    const { db, dal } = await setup();
    try {
      await dal.insertJob({
        url: "https://example.com/",
        normalizedUrl: "https://example.com/",
        urlHash: "wh-with-cb",
        callbackUrl: "https://hook.example.com/cb",
        consumerId: "how",
      });
      const job = await dal.claimNextJob(LEASE_TTL);

      const calls: { url: string; body?: string }[] = [];
      const requester: WebhookRequester = async (url, input) => {
        calls.push({ url, body: input.body });
        return okResult(url);
      };

      await runAudit(job!, {
        dal,
        scorer: scorer(),
        fetcher: okFetcher(),
        leaseTtlSecs: LEASE_TTL,
        maxAttempts: MAX_ATTEMPTS,
        webhookRequester: requester,
      });

      // Delivery is fire-and-forget (void) — allow the microtask to settle.
      await new Promise((r) => setTimeout(r, 50));

      expect(calls.length).toBe(1);
      const parsed = JSON.parse(calls[0]!.body!) as { job_id: string; status: string };
      expect(parsed.status).toBe("done");
      expect(parsed.job_id).toBe(job!.id);

      const after = await dal.getJob(job!.id);
      expect(after!.status).toBe("done"); // job state unaffected by delivery
    } finally {
      await db.close();
    }
  });

  it("WH-04b: does NOT fire when callbackUrl is absent", async () => {
    const { db, dal } = await setup();
    try {
      await dal.insertJob({
        url: "https://example.com/",
        normalizedUrl: "https://example.com/",
        urlHash: "wh-no-cb",
        consumerId: "how",
      });
      const job = await dal.claimNextJob(LEASE_TTL);

      const requester = vi.fn<WebhookRequester>(async (url) => okResult(url));

      await runAudit(job!, {
        dal,
        scorer: scorer(),
        fetcher: okFetcher(),
        leaseTtlSecs: LEASE_TTL,
        maxAttempts: MAX_ATTEMPTS,
        webhookRequester: requester,
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(requester).not.toHaveBeenCalled();
      const after = await dal.getJob(job!.id);
      expect(after!.status).toBe("done");
    } finally {
      await db.close();
    }
  });

  it("WH-04c: a failing delivery never fails the job (non-fatal)", async () => {
    const { db, dal } = await setup();
    try {
      await dal.insertJob({
        url: "https://example.com/",
        normalizedUrl: "https://example.com/",
        urlHash: "wh-fail-cb",
        callbackUrl: "https://hook.example.com/cb",
        consumerId: "how",
      });
      const job = await dal.claimNextJob(LEASE_TTL);

      const requester: WebhookRequester = async (url) => errResult(url, "FETCH_ERROR");

      await expect(
        runAudit(job!, {
          dal,
          scorer: scorer(),
          fetcher: okFetcher(),
          leaseTtlSecs: LEASE_TTL,
          maxAttempts: MAX_ATTEMPTS,
          webhookRequester: requester,
        }),
      ).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 50));

      const after = await dal.getJob(job!.id);
      expect(after!.status).toBe("done"); // delivery failure did not fail the job
    } finally {
      await db.close();
    }
  });
});
