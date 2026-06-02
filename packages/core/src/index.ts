/**
 * @geo/core — public barrel export
 *
 * This is the single public surface. All exports flow through here.
 * Zero runtime dependencies (D-04). No node: imports in src/.
 */

export type {
  FetchResult,
  Fetcher,
  AiCrawler,
  CrawlerStatus,
  RobotsResult,
  LlmsTxtResult,
  SchemaTemplateResult,
  StructuredDataValidationResult,
  CitabilityResult,
  RenderingResult,
} from "./types.js";

export { AI_CRAWLERS } from "./types.js";

export { normalizeUrl } from "./url.js";

export { checkRobots } from "./robots.js";

export { generateLlmsTxt, validateLlmsTxt } from "./llmstxt.js";
export type { CrawlData, CrawlPage, LlmsTxtValidationResult } from "./llmstxt.js";
