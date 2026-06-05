/**
 * @geo/cron one-shot entry point (D-1).
 *
 * Read + validate env (fail-fast), fire one POST /audit per configured URL, print
 * a redacted summary line, and exit with a code reflecting partial failure:
 *   exit 0  — every URL enqueued
 *   exit 1  — at least one URL failed (Coolify marks the scheduled task failed)
 *
 * No token is ever printed. Scheduling itself is owned by Coolify's scheduled-task
 * config; this process fires once and exits cleanly (rule 23).
 */

import { assertEnv, parseTargetUrls } from "./env.js";
import { runCron } from "./cron.js";

async function main(): Promise<void> {
  const env = assertEnv();
  const urls = parseTargetUrls(env.CRON_TARGET_URLS);

  const summary = await runCron({
    baseUrl: env.GEO_API_BASE_URL,
    token: env.CRON_API_TOKEN,
    urls,
  });

  console.log(
    `[cron] done: ${summary.succeeded}/${summary.total} enqueued, ${summary.failed} failed`,
  );
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  // env fail-fast or an unexpected throw — surface without leaking secrets.
  console.error(`[cron] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
