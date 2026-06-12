/**
 * Fail-fast env guard for @geo/worker.
 *
 * Security notes (T-04-INFO):
 * - ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN and DATABASE_URL are read from
 *   env only; never committed.
 * - Error messages name the variable but NEVER echo its value.
 * - No side effects on import — call assertEnv() explicitly at process start.
 *
 * Scoring provider (D — CLI/subscription support):
 * - "api" → Anthropic Messages API; requires ANTHROPIC_API_KEY.
 * - "cli" → Claude Code CLI (subscription); requires the `claude` binary to be
 *   authenticated, i.e. CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in a
 *   headless container, or an ambient `claude login` on a workstation.
 */

export type ScoringProvider = "api" | "cli";

/**
 * Resolve the scoring provider from env.
 * - Explicit SCORING_PROVIDER=cli|api wins.
 * - Otherwise: "api" when ANTHROPIC_API_KEY is set, else "cli".
 * Throws on an unrecognized explicit value.
 */
export function resolveScoringProvider(): ScoringProvider {
  const raw = process.env["SCORING_PROVIDER"]?.trim().toLowerCase();
  if (raw === "cli" || raw === "api") return raw;
  if (raw !== undefined && raw !== "") {
    throw new Error(
      `@geo/worker: SCORING_PROVIDER must be "cli" or "api" (got "${raw}").`,
    );
  }
  return process.env["ANTHROPIC_API_KEY"] ? "api" : "cli";
}

/**
 * Throws immediately if a required env var for the selected provider is unset.
 * Call once at worker startup before any other initialization.
 */
export function assertEnv(provider: ScoringProvider = resolveScoringProvider()): void {
  if (provider === "api") {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      throw new Error(
        "@geo/worker: ANTHROPIC_API_KEY is required for SCORING_PROVIDER=api but not set. " +
          "Set ANTHROPIC_API_KEY in your environment, or use SCORING_PROVIDER=cli. " +
          "Never commit a real API key.",
      );
    }
  } else {
    // provider === "cli": the `claude` binary must be authenticated. In a
    // headless container that means CLAUDE_CODE_OAUTH_TOKEN. We don't hard-fail
    // when it's absent (a workstation may rely on an ambient `claude login`),
    // but we warn so a misconfigured container surfaces the cause early.
    if (!process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
      console.warn(
        "[worker] SCORING_PROVIDER=cli but CLAUDE_CODE_OAUTH_TOKEN is not set. " +
          "The `claude` CLI must be authenticated (run `claude setup-token` and set " +
          "CLAUDE_CODE_OAUTH_TOKEN in a headless container, or `claude login` on a workstation), " +
          "otherwise scoring will fail.",
      );
    }
  }

  if (!process.env["DATABASE_URL"]) {
    throw new Error(
      "@geo/worker: DATABASE_URL is required but not set. " +
        "Set DATABASE_URL in your environment (see .env.example). " +
        "Do not include a real connection string in any committed file.",
    );
  }
}
