/**
 * @geo/api — createApp factory (D-01, D-02, D-14).
 *
 * Wave 0 scaffold: stands up an OpenAPIHono app with the rule-21 docs surface
 * (`/openapi.json` + `/docs`) and a single registered route so the OpenAPI
 * registry is non-empty. Waves 1/2 add submit/poll/history + auth middleware.
 *
 * Dependencies are injected (createApp({ dal, fetcher })) so tests pass a PGlite
 * DAL — there is NO module-level singleton DAL.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { AuditDal } from "@geo/db";
import type { createSafeFetcher } from "@geo/fetch";

export interface AppDeps {
  dal: AuditDal;
  fetcher: ReturnType<typeof createSafeFetcher>;
}

/**
 * Build the Hono app. Routes added in later waves; Wave 0 registers a liveness
 * probe (OpenAPI-first) so the spec has at least one path.
 */
export function createApp(deps: AppDeps): OpenAPIHono {
  // Hold the deps so later waves wire handlers; referenced to avoid unused-var.
  void deps;

  const app = new OpenAPIHono();

  const healthRoute = createRoute({
    method: "get",
    path: "/healthz",
    tags: ["system"],
    summary: "Liveness probe",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ status: z.literal("ok") }),
          },
        },
        description: "Service is alive",
      },
    },
  });

  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const }));

  // OpenAPI 3.1 spec — rule 21 required path.
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "@geo/api", version: "0.1.0" },
  });

  // Scalar UI — rule 21 required path.
  app.get("/docs", Scalar({ url: "/openapi.json", theme: "default" }));

  return app;
}
