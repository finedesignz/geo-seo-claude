/**
 * Fail-fast env guard + target-URL parser for @geo/cron.
 *
 * Security notes (T-04-INFO / T-07-01):
 * - CRON_API_TOKEN is read from env only; never committed, never logged.
 * - Error messages name the variable but NEVER echo a secret value.
 * - No side effects on import — call assertEnv() explicitly at process start.
 *
 * Config (D-2, 12-factor):
 * - CRON_TARGET_URLS — comma- OR newline-separated audit targets (validated up front).
 * - CRON_API_TOKEN   — bearer for the dedicated `cron` consumer (D-4). Required, never logged.
 * - GEO_API_BASE_URL — base URL of the geo-api service. Required, trailing slash stripped.
 * - CRON_SCHEDULE    — optional, informational only. The actual clock is Coolify's
 *                      scheduled-task config; this is the operator's source-of-truth value.
 */

export interface CronEnv {
  CRON_TARGET_URLS: string;
  CRON_API_TOKEN: string;
  GEO_API_BASE_URL: string;
}

/**
 * Parse CRON_TARGET_URLS into a validated list of http(s) URLs.
 *
 * Accepts comma- OR newline-separated entries (D-2), trims, drops empties, and
 * validates each remaining entry with `new URL()` BEFORE any POST (fail-fast).
 * Throws naming the offending value on an invalid URL, or if the list is empty
 * after parsing.
 */
export function parseTargetUrls(raw: string): string[] {
  const urls = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (urls.length === 0) {
    throw new Error("@geo/cron: CRON_TARGET_URLS is empty after parsing (no URLs found).");
  }
  for (const u of urls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new Error(`@geo/cron: CRON_TARGET_URLS contains an invalid URL: ${u}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `@geo/cron: CRON_TARGET_URLS entry must be http(s): ${u}`,
      );
    }
  }
  return urls;
}

/**
 * Throws immediately if any required CRON_* env var is unset. Strips a trailing
 * slash from GEO_API_BASE_URL (Pitfall 6: avoid `//audit`). Never echoes a token.
 * Call once at cron startup before any other initialization.
 */
export function assertEnv(): CronEnv {
  const required = ["CRON_TARGET_URLS", "CRON_API_TOKEN", "GEO_API_BASE_URL"] as const;
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(
        `@geo/cron: ${key} is required but not set. ` +
          "Set it in your environment (Coolify env in Phase 6). " +
          "Never commit a real token value.",
      );
    }
  }
  return {
    CRON_TARGET_URLS: process.env["CRON_TARGET_URLS"]!,
    CRON_API_TOKEN: process.env["CRON_API_TOKEN"]!,
    GEO_API_BASE_URL: process.env["GEO_API_BASE_URL"]!.replace(/\/+$/, ""),
  };
}
