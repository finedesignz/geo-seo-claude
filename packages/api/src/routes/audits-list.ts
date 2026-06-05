/**
 * @geo/api — GET /audits (API-03, D-06).
 *
 * Paginated audit history scoped to the AUTHENTICATED consumer. listJobs is
 * consumer-scoped (equality) so a caller only ever sees its own jobs; legacy
 * null-consumer rows never appear.
 *
 * Response DTO (D-15): each list item is an explicit narrowed shape —
 * { job_id, url, status, score?, created_at }. Internal columns
 * (callback_url, lease_token, attempts, locked_at, lease_expires_at,
 * consumer_id) are never serialized.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppDeps, AppVariables } from "../app.js";

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ param: { name: "page", in: "query" } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ param: { name: "limit", in: "query" } }),
});

/** Explicit list-item DTO (D-15) — no internal columns. */
const AuditListItem = z
  .object({
    job_id: z.string(),
    url: z.string(),
    status: z.enum(["queued", "running", "done", "failed"]),
    score: z.number().optional(),
    created_at: z.string(),
  })
  .openapi("AuditListItem");

const ListResponse = z
  .object({
    jobs: z.array(AuditListItem),
    page: z.number(),
    limit: z.number(),
  })
  .openapi("AuditListResult");

const ErrorResponse = z.object({ error: z.string(), message: z.string() }).openapi("ErrorEnvelope");

const route = createRoute({
  method: "get",
  path: "/audits",
  tags: ["audit"],
  summary: "List the caller's audit history (paginated)",
  security: [{ BearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: {
      content: { "application/json": { schema: ListResponse } },
      description: "Paginated audit history for the authenticated consumer",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Missing or invalid bearer token",
    },
  },
});

/** Register GET /audits (OpenAPI-first). */
export function registerAuditsList(
  app: OpenAPIHono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.openapi(route, async (c) => {
    const { page, limit } = c.req.valid("query");
    const consumerId = c.get("consumer_id");
    const offset = (page - 1) * limit;

    const rows = await deps.dal.listJobs({ consumerId, limit, offset });

    // Map each row to the DTO — never spread the raw AuditJob.
    const jobs = rows.map((r) => ({
      job_id: r.id,
      url: r.url,
      status: r.status,
      score: r.score ?? undefined,
      created_at: r.createdAt.toISOString(),
    }));

    return c.json({ jobs, page, limit }, 200);
  });
}
