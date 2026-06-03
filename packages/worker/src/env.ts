/**
 * Fail-fast env guard for @geo/worker.
 *
 * Security notes (T-04-INFO):
 * - ANTHROPIC_API_KEY and DATABASE_URL are read from env only; never committed.
 * - Error messages name the variable but NEVER echo its value.
 * - No side effects on import — call assertEnv() explicitly at process start.
 */

/**
 * Throws immediately if ANTHROPIC_API_KEY or DATABASE_URL is not set.
 * Call once at worker startup before any other initialization.
 */
export function assertEnv(): void {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "@geo/worker: ANTHROPIC_API_KEY is required but not set. " +
        "Set ANTHROPIC_API_KEY in your environment (Coolify env in Phase 6). " +
        "Never commit a real API key.",
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
