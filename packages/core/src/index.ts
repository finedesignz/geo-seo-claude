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
  CitabilityResult,
  RenderingResult,
} from "./types.js";

export { AI_CRAWLERS } from "./types.js";

export { normalizeUrl } from "./url.js";

export { checkRobots } from "./robots.js";

export { generateLlmsTxt, validateLlmsTxt } from "./llmstxt.js";
export type { CrawlData, CrawlPage, LlmsTxtValidationResult } from "./llmstxt.js";

export { getSchemaTemplates, validateStructuredData, SCHEMA_TYPES, MAX_HTML_BYTES } from "./schema.js";
export type { SchemaType, StructuredDataEntry, StructuredDataValidationResult } from "./schema.js";

export { computeCitabilityScore, scorePassage, CITABILITY_WEIGHTS } from "./citability.js";
export type { CitabilityWeightKey, PageData, PassageResult, CitabilityResult } from "./citability.js";
