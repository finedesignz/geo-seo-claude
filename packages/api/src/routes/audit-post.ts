/**
 * @geo/api — POST /audit (API-01 / API-04 / API-08).
 *
 * Flow: zod-validate {url, callback_url?} → normalize → url_hash → CONSUMER-SCOPED
 * dedup → submit-time callback SSRF check → insert → { job_id }. Returns
 * immediately; the worker performs the audit (never blocks the request).
 *
 * Dedup semantics (D-04 / D-13):
 *   - findRecentByUrlHash is consumer-scoped: a recent done|queued|running job
 *     for THIS consumer within DEDUP_TTL_MS returns the cached job_id with no
 *     new insert. One consumer never dedups against another's job.
 *   - A prior `failed` job does NOT dedup — it re-enqueues (new job_id).
 *
 * Callback SSRF (D-08 / T-05-01-03): if callback_url is present it is validated
 * via @geo/fetch validateUrlHost (DNS resolve + IP classify, no HTTP request)
 * BEFORE any insert; a private/loopback/blocked host → 400 ssrf_blocked.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { normalizeUrl } from "@geo/core";
import { validateUrlHost } from "@geo/fetch";
import type { AppDeps, AppVariables } from "../app.js";

/**
 * Dedup window. 1 hour: long enough to collapse retry storms / duplicate submits
 * for the same consumer+url, short enough that a re-audit is available hourly.
 */
export const DEDUP_TTL_MS = 60 * 60 * 1000;

const RequestBody = z
  .object({
    url: z.string().url(),
    callback_url: z.string().url().optional(),
  })
  .openapi("AuditSubmit");

const SuccessResponse = z.object({ job_id: z.string() }).openapi("AuditSubmitResult");
const ErrorResponse = z.object({ error: z.string(), message: z.string() }).openapi("ErrorEnvelope");

const route = createRoute({
  method: "post",
  path: "/audit",
  tags: ["audit"],
  summary: "Submit a URL for a GEO audit",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: RequestBody } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: SuccessResponse } },
      description: "Job accepted (or deduped to an existing job)",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid body or blocked callback_url",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Missing or invalid bearer token",
    },
  },
});

/** Register POST /audit on the app (OpenAPI-first; never app.post). */
export function registerAuditPost(
  app: OpenAPIHono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.openapi(route, async (c) => {
    const { url, callback_url } = c.req.valid("json");
    const consumerId = c.get("consumer_id");

    // Normalize + hash (normalized URL is the dedup basis).
    const { url: normalized, errors } = normalizeUrl(url);
    if (errors.length > 0 || normalized === "") {
      return c.json({ error: "invalid_url", message: errors[0] ?? "Invalid url" }, 400);
    }
    const urlHash = createHash("sha256").update(normalized, "utf8").digest("hex");

    // Consumer-scoped dedup. A `failed` prior job does NOT dedup (re-enqueue).
    const recent = await deps.dal.findRecentByUrlHash(urlHash, DEDUP_TTL_MS, consumerId);
    if (recent && recent.status !== "failed") {
      return c.json({ job_id: recent.id }, 200);
    }

    // Submit-time callback SSRF check (no insert if blocked).
    if (callback_url) {
      const ssrf = await validateUrlHost(callback_url, { resolver: deps.callbackResolver });
      if (!ssrf.ok) {
        return c.json(
          { error: "ssrf_blocked", message: "callback_url resolves to a blocked host" },
          400,
        );
      }
    }

    const job = await deps.dal.insertJob({
      url,
      normalizedUrl: normalized,
      urlHash,
      callbackUrl: callback_url,
      consumerId,
    });

    return c.json({ job_id: job.id }, 200);
  });
}
