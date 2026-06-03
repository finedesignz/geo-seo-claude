/**
 * @geo/worker — scorer.ts
 *
 * Converts a deterministic @geo/core FindingsShape into a validated {score, findings}
 * via ONE forced-tool-use Anthropic messages.create call, with prompt caching on the
 * static rubric and an AbortController timeout.
 *
 * IMPORTANT (RESEARCH Pitfall 1 / T-04-RETRY):
 * The production Anthropic client MUST be constructed with `maxRetries: 0`:
 *   new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })
 * The SDK defaults to maxRetries:2, which auto-retries 429/529/5xx internally.
 * With maxRetries>0, the AbortController timeout can expire mid-SDK-retry and throw
 * APIConnectionTimeoutError instead of RateLimitError, mis-classifying the retry
 * disposition. Set maxRetries:0 and let the lease/attempts mechanism own retries.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AnthropicMessagesClient } from "./types.js";
import type { FindingsShape } from "@geo/db";

// ---------------------------------------------------------------------------
// ScoringError
// ---------------------------------------------------------------------------

export class ScoringError extends Error {
  constructor(
    public readonly code:
      | "SCORING_TIMEOUT"
      | "SCORING_RATE_LIMITED"
      | "SCORING_API_ERROR"
      | "SCORING_MALFORMED_OUTPUT",
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ScoringError";
  }
}

// ---------------------------------------------------------------------------
// GeoScoreSchema — zod validation for tool_use.input
// ---------------------------------------------------------------------------

export const GeoScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  findings: z.record(z.string(), z.unknown()),
});

export type GeoScoreOutput = z.infer<typeof GeoScoreSchema>;

// ---------------------------------------------------------------------------
// GEO_SCORING_RUBRIC — static system block (the prompt-cached prefix)
//
// This string is stable and static across all scoring calls. It carries
// cache_control:{type:'ephemeral'} and is the cached prefix proven by
// usage.cache_creation_input_tokens / usage.cache_read_input_tokens metadata.
// Do NOT include any dynamic per-job content here.
// ---------------------------------------------------------------------------

export const GEO_SCORING_RUBRIC = `
# GEO Score — AI Visibility & Crawlability Scoring System

## Purpose

You are an expert GEO (Generative Engine Optimization) auditor. Your task is to evaluate
a web page's readiness for AI-driven search engines, LLM crawlers, and generative retrieval
systems. You will receive a structured findings object produced by deterministic checks run
on the target URL. Your job is to synthesize these findings into a single 0–100 GEO score
and provide per-dimension assessments with brief rationale.

Use the tool \`record_geo_score\` to return your evaluation. Do not respond in plain text.

## Scoring Philosophy

A GEO score reflects how well a page is positioned to be accurately cited, summarized,
and recommended by AI assistants (ChatGPT, Claude, Gemini, Perplexity, Bing AI, etc.).
The score is not an SEO score — it specifically measures AI-readiness along six dimensions:

1. **Crawlability** — Can AI crawlers access the page? (robots.txt, noindex, disallow rules)
2. **LLMs.txt compliance** — Does the site provide an llms.txt file to guide AI agents?
3. **Schema templates** — Are schema.org templates present and valid for key entity types?
4. **Structured data** — Is JSON-LD / Microdata / RDFa used correctly and validly?
5. **Citability** — Does the page have clear authorship, dates, canonical URLs, and attributable claims?
6. **Rendering** — Is the content server-side rendered (SSR) and accessible without JavaScript?

## Dimension Rubrics

### 1. Crawlability (0–20 points)

Score this dimension based on whether AI crawlers can reach and index the page.

| Points | Condition |
|--------|-----------|
| 20     | No robots.txt restrictions; no noindex/nofollow meta; Anthropic/GPTBot/Googlebot-all allowed |
| 16–19  | Minor restrictions; crawlers allowed but some paths blocked |
| 10–15  | Mixed signals; some crawlers blocked, others allowed |
| 5–9    | Major crawler blocks; GPTBot or Anthropic-Bot explicitly disallowed |
| 0–4    | noindex on page or all crawlers disallowed via robots.txt |

Key signals:
- robots.txt User-agent: * Disallow: / → 0–2 points
- Specific AI crawler disallow (GPTBot, Anthropic-Bot, PerplexityBot, ClaudeBot) → deduct 5–10
- X-Robots-Tag: noindex on response headers → 0 points for this dimension
- Permissive robots.txt with no AI-specific blocks → full points

### 2. LLMs.txt Compliance (0–15 points)

Score based on presence, validity, and quality of the /llms.txt file.

| Points | Condition |
|--------|-----------|
| 15     | /llms.txt present; well-structured; includes # header, description, links with [[description]] |
| 10–14  | Present but minimal; has header and some links |
| 5–9    | Present but malformed or empty |
| 0–4    | No /llms.txt file; optional /llms-full.txt also absent |

Key signals:
- llmsTxt.present=false → 0–2 points
- llmsTxt.valid=true + has sections → 15 points
- llmsTxt.sections count and link count positively correlate with score

### 3. Schema Templates (0–15 points)

Score based on schema.org template presence and relevance.

| Points | Condition |
|--------|-----------|
| 15     | Multiple relevant schema types present (Article/BlogPost + Organization + WebPage + BreadcrumbList) |
| 10–14  | 2–3 relevant types; no errors |
| 5–9    | 1 schema type or has validation errors |
| 0–4    | No schema templates or completely invalid |

Key signals:
- schemaTemplate.types array length and recognized types
- schemaTemplate.errors count (errors reduce score)
- Article/NewsArticle/BlogPost schema → high relevance for content pages
- Product/LocalBusiness schema → high relevance for commerce pages

### 4. Structured Data Validation (0–20 points)

Score based on JSON-LD / Microdata / RDFa presence and validity.

| Points | Condition |
|--------|-----------|
| 20     | All structured data parses cleanly; no validation errors; required fields present |
| 15–19  | Minor issues; data present and mostly valid |
| 8–14   | Structured data present but has validation errors or missing required fields |
| 0–7    | No structured data, or unparseable, or critically malformed |

Key signals:
- structuredData.valid=true → full credit
- structuredData.errors array: each error deducts points
- structuredData.types: presence of @type with recognized schema.org types
- JSON-LD is preferred over Microdata (cleaner separation)

### 5. Citability (0–15 points)

Score based on signals that enable AI systems to accurately cite and attribute the content.

| Points | Condition |
|--------|-----------|
| 15     | Clear author, publication date, canonical URL, organization name; content is factual and attributable |
| 10–14  | Most signals present; missing one (e.g., author or date) |
| 5–9    | Some signals; no author or no date; canonical may be missing |
| 0–4    | No authorship, no dates, no canonical, or thin/non-attributable content |

Key signals:
- citability.hasAuthor, citability.hasDate, citability.hasCanonical
- citability.organizationName presence
- citability.contentType (article/product/service → higher citability potential)
- Canonical URL matches the requested URL (not redirected to another domain)

### 6. Rendering / SSR Detection (0–15 points)

Score based on whether page content is accessible without JavaScript execution.

| Points | Condition |
|--------|-----------|
| 15     | Full SSR; all visible content present in initial HTML; no hydration gaps |
| 10–14  | Mostly SSR; minor dynamic elements |
| 5–9    | Hybrid; some content SSR, some requires JS |
| 0–4    | CSR/SPA; critical content missing from initial HTML; requires JS execution to render |

Key signals:
- rendering.isSSR=true → full points
- rendering.isCSR=true → 0–4 points
- rendering.hydrationGap: if significant content is missing from static HTML
- rendering.framework (Next.js SSR / Nuxt SSR vs React SPA / Vue SPA)

## Synthesis Rules

When computing the final score (0–100):
1. Sum all six dimension scores using the rubric above.
2. Apply penalties for critical failures:
   - All crawlers blocked by robots.txt → cap total at 30
   - noindex directive present → cap total at 25
   - No structured data AND no schema templates → deduct 5 from total
3. Apply bonus for excellence:
   - All six dimensions score ≥ 80% of their max → add 5 bonus points (cap at 100)
4. Round to the nearest integer; clamp to [0, 100].

## Output Format

You MUST call the \`record_geo_score\` tool with:
- \`score\`: integer 0–100 representing the overall GEO readiness score
- \`findings\`: an object with per-dimension assessments, each containing:
  - \`points\`: the sub-score awarded for that dimension
  - \`maxPoints\`: the maximum points possible for that dimension
  - \`rationale\`: 1–2 sentence explanation of the score
  - \`keySignals\`: array of 1–3 specific signals from the findings that drove the score

Example findings structure (adapt based on actual findings data):
{
  "crawlability": { "points": 18, "maxPoints": 20, "rationale": "...", "keySignals": ["..."] },
  "llmsTxt": { "points": 12, "maxPoints": 15, "rationale": "...", "keySignals": ["..."] },
  "schemaTemplates": { "points": 10, "maxPoints": 15, "rationale": "...", "keySignals": ["..."] },
  "structuredData": { "points": 16, "maxPoints": 20, "rationale": "...", "keySignals": ["..."] },
  "citability": { "points": 11, "maxPoints": 15, "rationale": "...", "keySignals": ["..."] },
  "rendering": { "points": 13, "maxPoints": 15, "rationale": "...", "keySignals": ["..."] }
}

## Important Notes

- Base your evaluation ONLY on the findings object provided. Do not make assumptions about
  content you have not seen.
- The findings object is deterministic — it was computed by static analysis tools, not LLM
  inference. Trust the data; apply your judgment only in the synthesis and dimension scoring.
- If a findings field is null or undefined, treat that dimension as unknown and score conservatively.
- Your role is pure judgment (weighting and synthesis into 0–100); the deterministic checks
  have already done the measurement work. You synthesize; you do not measure.
- Consistency is critical: given the same findings object, your score should be stable
  (±2 points) across runs. Be systematic, not impressionistic.
`.trim();

// ---------------------------------------------------------------------------
// record_geo_score tool definition
// ---------------------------------------------------------------------------

const RECORD_GEO_SCORE_TOOL: Anthropic.Tool = {
  name: "record_geo_score",
  description:
    "Record the GEO score and per-dimension findings for the audited page. " +
    "Call this tool exactly once with the computed score (0–100 integer) and " +
    "a findings object containing per-dimension sub-scores and rationale.",
  input_schema: {
    type: "object" as const,
    properties: {
      score: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Overall GEO readiness score, 0 (worst) to 100 (best)",
      },
      findings: {
        type: "object",
        description:
          "Per-dimension assessments. Keys are dimension names; values contain " +
          "points, maxPoints, rationale, and keySignals.",
        additionalProperties: true,
      },
    },
    required: ["score", "findings"],
  },
};

// ---------------------------------------------------------------------------
// classifyScoringError — maps SDK error types to ScoringError
// ---------------------------------------------------------------------------

export function classifyScoringError(err: unknown): ScoringError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ScoringError("SCORING_TIMEOUT", true);
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ScoringError("SCORING_TIMEOUT", true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ScoringError("SCORING_API_ERROR", true);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ScoringError("SCORING_RATE_LIMITED", true);
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new ScoringError("SCORING_API_ERROR", true);
  }
  if (err instanceof Anthropic.APIError) {
    return new ScoringError("SCORING_API_ERROR", err.status >= 500);
  }
  return new ScoringError("SCORING_API_ERROR", false);
}

// ---------------------------------------------------------------------------
// createScorer — factory returning the score() function
// ---------------------------------------------------------------------------

export interface ScorerOptions {
  model: string;
  timeoutMs: number;
}

export interface ScoreResult {
  score: number;
  findings: Record<string, unknown>;
  usage: Anthropic.Usage;
}

export function createScorer(
  client: AnthropicMessagesClient,
  opts: ScorerOptions,
) {
  return {
    async score(
      findings: FindingsShape,
      externalSignal?: AbortSignal,
    ): Promise<ScoreResult> {
      const ac = new AbortController();

      // Link external signal (lease-loss abort) to our controller
      if (externalSignal?.aborted) {
        ac.abort();
      } else if (externalSignal) {
        externalSignal.addEventListener("abort", () => ac.abort(), {
          once: true,
        });
      }

      const timer = setTimeout(() => ac.abort(), opts.timeoutMs);

      try {
        const response = await client.messages.create(
          {
            model: opts.model,
            max_tokens: 1024,
            system: [
              {
                type: "text",
                text: GEO_SCORING_RUBRIC,
                cache_control: { type: "ephemeral" },
              },
            ],
            tools: [RECORD_GEO_SCORE_TOOL],
            tool_choice: { type: "tool", name: "record_geo_score" },
            messages: [
              {
                role: "user",
                content: JSON.stringify(findings),
              },
            ],
          },
          { signal: ac.signal },
        );

        // Extract tool_use block
        const toolUseBlock = response.content.find(
          (b) => b.type === "tool_use",
        );
        if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
          throw new ScoringError("SCORING_MALFORMED_OUTPUT", true);
        }

        // zod-validate the tool_use input
        const parsed = GeoScoreSchema.safeParse(toolUseBlock.input);
        if (!parsed.success) {
          throw new ScoringError("SCORING_MALFORMED_OUTPUT", true);
        }

        return {
          score: parsed.data.score,
          findings: parsed.data.findings,
          usage: response.usage,
        };
      } catch (err) {
        // Re-throw ScoringErrors directly (SCORING_MALFORMED_OUTPUT from above)
        if (err instanceof ScoringError) {
          throw err;
        }
        // Classify and rethrow SDK errors
        throw classifyScoringError(err);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
