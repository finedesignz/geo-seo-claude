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

import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { AuditDal } from "@geo/db";
import type { createSafeFetcher } from "@geo/fetch";
import { bearerAuth } from "./middleware/auth.js";
import { registerAuditPost } from "./routes/audit-post.js";
import { registerAuditGet } from "./routes/audit-get.js";
import { registerAuditsList } from "./routes/audits-list.js";
import { registerHealthz } from "./routes/healthz.js";

/** Injectable DNS resolver: hostname → all A+AAAA addresses. */
export type CallbackResolver = (hostname: string) => Promise<string[]>;

export interface AppDeps {
  dal: AuditDal;
  fetcher: ReturnType<typeof createSafeFetcher>;
  /** token→consumer_id map (built from GEO_API_KEYS in main.ts; injected in tests). */
  apiKeys: Map<string, string>;
  /**
   * Optional resolver injected into the submit-time callback_url SSRF check so
   * tests can simulate private/loopback DNS without real network. Defaults to
   * the real resolver inside validateUrlHost when omitted.
   */
  callbackResolver?: CallbackResolver;
}

/** Hono context variable typing shared across the app. */
export type AppVariables = { consumer_id: string };

/**
 * Build the Hono app. Routes added in later waves; Wave 0 registers a liveness
 * probe (OpenAPI-first) so the spec has at least one path.
 */
export function createApp(deps: AppDeps): OpenAPIHono<{ Variables: AppVariables }> {
  const app = new OpenAPIHono<{ Variables: AppVariables }>();

  // Bearer security scheme registered on the OpenAPI registry so the generated
  // spec carries components.securitySchemes.BearerAuth (API-07). Protected
  // routes reference security:[{BearerAuth:[]}].
  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
  });

  // Bearer auth on every route; EXEMPT set (healthz/openapi/docs) is handled
  // inside the middleware so the docs surface stays public (rule 21).
  app.use("*", bearerAuth(deps.apiKeys));

  // GET /healthz — deep DB check (public, auth-exempt).
  registerHealthz(app, deps);

  // POST /audit — submit slice (Wave 1).
  registerAuditPost(app, deps);

  // GET /audit/{job_id} — poll (Wave 2).
  registerAuditGet(app, deps);

  // GET /audits — paginated history (Wave 2).
  registerAuditsList(app, deps);

  // OpenAPI 3.1 spec — rule 21 required path.
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "@geo/api", version: "0.1.0" },
  });

  // Scalar UI — rule 21 required path.
  app.get("/docs", Scalar({ url: "/openapi.json", theme: "default" }));

  return app;
}
