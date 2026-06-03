// @geo/worker — public barrel (wave 0 scaffold)

// Env guard
export { assertEnv } from "./env.js";

// Injection seam types
export type { AnthropicMessagesClient, WorkerOptions } from "./types.js";

// wave 1
export {
  ScoringError,
  GeoScoreSchema,
  GEO_SCORING_RUBRIC,
  createScorer,
  classifyScoringError,
} from "./scorer.js";
export type { GeoScoreOutput, ScorerOptions, ScoreResult } from "./scorer.js";
// wave 2: export { runWorker } from "./worker.js";
