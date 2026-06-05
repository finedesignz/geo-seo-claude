// @geo/api — public surface (Wave 1).

export { createApp } from "./app.js";
export type { AppDeps, AppVariables, CallbackResolver } from "./app.js";
export { parseApiKeys, bearerAuth, EXEMPT } from "./middleware/auth.js";
export { registerAuditPost, DEDUP_TTL_MS } from "./routes/audit-post.js";
export { registerAuditGet } from "./routes/audit-get.js";
export { registerAuditsList } from "./routes/audits-list.js";
export { registerHealthz } from "./routes/healthz.js";
