/**
 * @geo/api — Bun.serve entry (D-01). Phase 6 containerizes this.
 *
 * DAL/fetcher are resolved lazily inside fetch() so importing this module does
 * NOT throw without DATABASE_URL (mirrors @geo/db getDefaultDal lazy pattern).
 */

import { getDefaultDal } from "@geo/db";
import { createSafeFetcher } from "@geo/fetch";
import { createApp } from "./app.js";
import { parseApiKeys } from "./middleware/auth.js";

let _app: ReturnType<typeof createApp> | undefined;

function getApp(): ReturnType<typeof createApp> {
  if (_app) return _app;
  // Fail-fast at startup: GEO_API_KEYS must be present and parse to >=1 pair.
  const apiKeys = parseApiKeys(process.env.GEO_API_KEYS);
  _app = createApp({ dal: getDefaultDal(), fetcher: createSafeFetcher(), apiKeys });
  return _app;
}

export default {
  port: Number(process.env.PORT ?? 8080),
  fetch: (req: Request) => getApp().fetch(req),
};
