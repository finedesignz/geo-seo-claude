/**
 * @geo/api — GET /healthz (API-06, D-07).
 *
 * DEEP health check: runs `SELECT 1` through @geo/db (deps.dal.ping). When the
 * DB is reachable → 200 { status:'ok', db:'ok' }; when the query throws
 * (connection down/closed) → 503 { status:'error', db:'error' }.
 *
 * PUBLIC — no bearer token required (the path is in the auth EXEMPT set so
 * Coolify health probes can reach it).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppDeps, AppVariables } from "../app.js";

const OkResponse = z
  .object({ status: z.literal("ok"), db: z.literal("ok") })
  .openapi("HealthOk");

const ErrorResponseHealth = z
  .object({ status: z.literal("error"), db: z.literal("error") })
  .openapi("HealthError");

const route = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["system"],
  summary: "Deep liveness probe (DB SELECT 1)",
  responses: {
    200: {
      content: { "application/json": { schema: OkResponse } },
      description: "Service + DB reachable",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseHealth } },
      description: "DB unreachable",
    },
  },
});

/** Register GET /healthz (OpenAPI-first; public — auth-exempt). */
export function registerHealthz(
  app: OpenAPIHono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.openapi(route, async (c) => {
    try {
      await deps.dal.ping();
      return c.json({ status: "ok" as const, db: "ok" as const }, 200);
    } catch {
      return c.json({ status: "error" as const, db: "error" as const }, 503);
    }
  });
}
