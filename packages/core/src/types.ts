/**
 * @geo/core — type seam and shared result types (D-05, D-06)
 *
 * CRITICAL SEAM (D-05): @geo/core performs zero network I/O.
 * The Fetcher type is the injection point — callers supply a conforming implementation.
 * FetchResult.headers are lowercase-keyed (HTTP/2 convention; provide normalization at call site).
 */

// ---------------------------------------------------------------------------
// Fetch injection seam (D-05)
// ---------------------------------------------------------------------------

export interface FetchResult {
  url: string;
  status: number;
  /** Lowercase-keyed headers map (normalize at injection site, not here). */
  headers: Record<string, string>;
  /** Raw response body text. */
  body: string;
  redirectChain: Array<{ url: string; status: number }>;
  error?: string;
}

export type Fetcher = (url: string) => Promise<FetchResult>;

// ---------------------------------------------------------------------------
// AI crawler list (ported from scripts/fetch_page.py AI_CRAWLERS keys)
// ---------------------------------------------------------------------------

export const AI_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "GoogleBot",
  "BingBot",
] as const;

export type AiCrawler = (typeof AI_CRAWLERS)[number];

// ---------------------------------------------------------------------------
// Shared result-type stubs (D-06: errors: string[], no throw for expected failures)
// Wave 1 fills in the full fields; barrel always exports these so imports never break.
// ---------------------------------------------------------------------------

export interface RobotsResult {
  url: string;
  sitemapUrls: string[];
  /** Crawlability per AI agent: key = AiCrawler name, value = allowed */
  crawlability: Record<string, boolean>;
  errors: string[];
}

export interface LlmsTxtResult {
  content: string;
  sections: Array<{ title: string; items: Array<{ title: string; url: string; description?: string }> }>;
  errors: string[];
}

export interface SchemaTemplateResult {
  templates: Array<{ type: string; json: unknown }>;
  detected: Array<{ type: string; raw: string }>;
  errors: string[];
}

export interface StructuredDataValidationResult {
  valid: boolean;
  findings: Array<{ field: string; message: string }>;
  errors: string[];
}

export interface CitabilityResult {
  score: number;
  breakdown: Record<string, number>;
  signals: string[];
  errors: string[];
}

export interface RenderingResult {
  rendering: "SSR" | "CSR" | "UNKNOWN";
  confidence: number;
  signals: string[];
  errors: string[];
}
