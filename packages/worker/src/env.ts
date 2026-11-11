/**
 * Fail-fast env guard for @geo/worker.
 *
 * Security notes (T-04-INFO):
 * - CLAUDE_CODE_OAUTH_TOKEN and DATABASE_URL are read from env only; never committed.
 * - Error messages name the variable but NEVER echo its value.
 * - No side effects on import -- call assertEnv() explicitly at process start.
 *
 * Scoring provider: the Claude Code CLI (subscription OAuth) is the ONLY path.
 * It requires the `claude` binary to be authenticated, i.e. CLAUDE_CODE_OAUTH_TOKEN
 * (from `claude setup-token`) in a headless container, or an ambient `claude login`
 * on a workstation. API-key scoring was removed (rule 22c); ANTHROPIC_API_KEY is
 * never read to authenticate.
 */

export type ScoringProvider = "cli";

/**
 * Resolve the scoring provider from env. Unset or "cli" -> "cli".
 * Any other SCORING_PROVIDER value throws (the "api" mode was removed).
 */
export function resolveScoringProvider(): ScoringProvider {
  const raw = process.env["SCORING_PROVIDER"]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "cli") return "cli";
  throw new Error(
    `@geo/worker: SCORING_PROVIDER "${raw}" was removed (API keys are not allowed); only "cli" is supported.`,
  );
}

/**
 * Throws immediately if a required env var is unset.
 * Call once at worker startup before any other initialization.
 */
export function assertEnv(): void {
  resolveScoringProvider();

  // The `claude` binary must be authenticated. In a headless container that
  // means CLAUDE_CODE_OAUTH_TOKEN. We don't hard-fail when it's absent (a
  // workstation may rely on an ambient `claude login`), but we warn so a
  // misconfigured container surfaces the cause early.
  if (!process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    console.warn(
      "[worker] CLAUDE_CODE_OAUTH_TOKEN is not set. " +
        "The `claude` CLI must be authenticated (run `claude setup-token` and set " +
        "CLAUDE_CODE_OAUTH_TOKEN in a headless container, or `claude login` on a workstation), " +
        "otherwise scoring will fail.",
    );
  }

  if (!process.env["DATABASE_URL"]) {
    throw new Error(
      "@geo/worker: DATABASE_URL is required but not set. " +
        "Set DATABASE_URL in your environment (see .env.example). " +
        "Do not include a real connection string in any committed file.",
    );
  }
}
