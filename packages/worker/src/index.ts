// @geo/worker — public barrel (wave 0 scaffold)

// Env guard + scoring-provider resolution
export { assertEnv, resolveScoringProvider } from "./env.js";
export type { ScoringProvider } from "./env.js";

// Injection seam types
export type { AnthropicMessagesClient, WorkerOptions, Scorer } from "./types.js";

// Claude Code CLI (subscription) scorer
export { createCliScorer, buildCliArgv, extractCliResult } from "./cli-scorer.js";
export type { CliScorerOptions, CliSpawnFn, CliSpawnResult } from "./cli-scorer.js";

// wave 1
export {
  ScoringError,
  GeoScoreSchema,
  GEO_SCORING_RUBRIC,
  createScorer,
  classifyScoringError,
} from "./scorer.js";
export type { GeoScoreOutput, ScorerOptions, ScoreResult } from "./scorer.js";
// wave 2
export { runWorker } from "./worker.js";
export { runAudit } from "./pipeline.js";
export type { PipelineDeps } from "./pipeline.js";
export { deliverWebhook } from "./webhook.js";
export type { WebhookRequester, WebhookPayload, DeliverWebhookDeps } from "./webhook.js";
