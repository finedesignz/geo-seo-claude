/**
 * @geo/api — GET /audit/{job_id} (API-02, D-05).
 *
 * Poll a single audit job. Ownership-scoped: a job not found OR owned by a
 * DIFFERENT consumer returns 404 (no cross-consumer read, no existence leak).
 *
 * Response DTO (D-15): an explicit narrowed shape — NEVER a raw AuditJob row.
 * Internal columns (callback_url, lease_token, attempts, locked_at,
 * lease_expires_at, consumer_id) are never serialized. score+findings are
 * present only when the job is done; error_code only on a failed job.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppDeps, AppVariables } from "../app.js";

const Params = z.object({
  job_id: z.string().openapi({ param: { name: "job_id", in: "path" }, example: "..." }),
});

/** Explicit poll DTO (D-15) — no internal columns. */
const PollResponse = z
  .object({
    status: z.enum(["queued", "running", "done", "failed"]),
    score: z.number().optional(),
    findings: z.record(z.string(), z.unknown()).optional(),
    error_code: z.string().optional(),
  })
  .openapi("AuditPollResult");

const ErrorResponse = z.object({ error: z.string(), message: z.string() }).openapi("ErrorEnvelope");

const route = createRoute({
  method: "get",
  path: "/audit/{job_id}",
  tags: ["audit"],
  summary: "Poll the status of a submitted audit",
  security: [{ BearerAuth: [] }],
  request: { params: Params },
  responses: {
    200: {
      content: { "application/json": { schema: PollResponse } },
      description: "Current job status (score+findings when done)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Missing or invalid bearer token",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Job not found or not owned by the caller",
    },
  },
});

/** Register GET /audit/{job_id} (OpenAPI-first). */
export function registerAuditGet(
  app: OpenAPIHono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.openapi(route, async (c) => {
    const { job_id } = c.req.valid("param");
    const consumerId = c.get("consumer_id");

    const job = await deps.dal.getJob(job_id);
    // Ownership check (D-05): not found OR not owned → 404 (no existence leak).
    if (!job || job.consumerId !== consumerId) {
      return c.json({ error: "not_found", message: "Job not found" }, 404);
    }

    // Build the DTO explicitly — never spread the raw row. Keys are only added
    // when present so internal columns never leak and the shape stays narrow.
    const body: z.infer<typeof PollResponse> = { status: job.status };
    if (job.status === "done") {
      if (job.score !== null) body.score = job.score;
      if (job.findings !== null) body.findings = job.findings as Record<string, unknown>;
    } else if (job.status === "failed" && job.errorCode !== null) {
      body.error_code = job.errorCode;
    }
    return c.json(body, 200);
  });
}
