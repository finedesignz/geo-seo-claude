/**
 * citability.ts — CORE-04
 * Deterministic 0–100 citability scoring. Zero runtime deps. No LLM/network.
 * Ported from scripts/citability_scorer.py (D-11). Weights exported as `as const` (D-07).
 *
 * Security: ReDoS guard — all regex uses bounded/lazy quantifiers.
 *           Input length guard (MAX_HTML_BYTES) applied before regex work.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum HTML input size (bytes) before early return with error. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB

/** Citability category weights — single source of truth for Phase 4 prompt (D-07). Sums to 100. */
export const CITABILITY_WEIGHTS = Object.freeze({
  answer_block_quality: 30,
  self_containment: 25,
  structural_readability: 20,
  statistical_density: 15,
  uniqueness_signals: 10,
} as const);

export type CitabilityWeightKey = keyof typeof CITABILITY_WEIGHTS;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PageData {
  html: string;
  url?: string;
}

export interface PassageResult {
  heading: string | undefined;
  word_count: number;
  total_score: number;
  breakdown: Record<CitabilityWeightKey, number>;
}

export interface CitabilityResult {
  score: number;
  breakdown: Record<CitabilityWeightKey, number>;
  blocksAnalyzed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Category helpers (bounded/lazy regex — ReDoS safe)
// ---------------------------------------------------------------------------

function scoreAnswerBlockQuality(text: string, words: string[], heading?: string): number {
  let score = 0;

  // Definition patterns — using lazy bounded alternation (no nested quantifiers)
  const definitionPatterns = [
    /\b\w{1,40}\s+is\s+(?:a|an|the)\s/i,
    /\b\w{1,40}\s+refers?\s+to\s/i,
    /\b\w{1,40}\s+means?\s/i,
    /\b\w{1,40}\s+(?:can\s+be\s+|are\s+)?defined\s+as\s/i,
    /\bin\s+(?:simple|other)\s+(?:terms|words)\s*,/i,
  ];
  for (const pat of definitionPatterns) {
    if (pat.test(text)) {
      score += 15;
      break;
    }
  }

  // Answer appears early (first 60 words) — bounded slice
  const first60 = words.slice(0, 60).join(" ");
  const earlyAnswerPatterns = [
    /\b(?:is|are|was|were|means?|refers?)\b/i,
    /\d+%/,
    /\$[\d,]{1,20}/,
    /\d+\s+(?:million|billion|thousand)/i,
  ];
  if (earlyAnswerPatterns.some(p => p.test(first60))) {
    score += 15;
  }

  // Question heading bonus
  if (heading && heading.trimEnd().endsWith("?")) {
    score += 10;
  }

  // Sentence clarity ratio — split on sentence-ending punctuation (bounded)
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 0) {
    const shortClear = sentences.filter(s => {
      const wc = s.trim().split(/\s+/).length;
      return wc >= 5 && wc <= 25;
    }).length;
    const ratio = shortClear / sentences.length;
    score += Math.floor(ratio * 10);
  }

  // Quotable claim
  if (/(?:according to|research shows|studies?\s+(?:show|indicate|suggest|found)|data\s+(?:shows|indicates|suggests))/i.test(text)) {
    score += 10;
  }

  return Math.min(score, CITABILITY_WEIGHTS.answer_block_quality);
}

function scoreSelfContainment(text: string, words: string[]): number {
  const wordCount = words.length;
  let score = 0;

  // Optimal word count
  if (wordCount >= 134 && wordCount <= 167) {
    score += 10;
  } else if (wordCount >= 100 && wordCount <= 200) {
    score += 7;
  } else if (wordCount >= 80 && wordCount <= 250) {
    score += 4;
  } else if (wordCount < 30 || wordCount > 400) {
    score += 0;
  } else {
    score += 2;
  }

  // Low pronoun density (bounded list of pronouns, no nested quantifiers)
  const pronounMatches = text.match(/\b(?:it|they|them|their|this|that|these|those|he|she|his|her)\b/gi);
  const pronounCount = pronounMatches ? pronounMatches.length : 0;
  if (wordCount > 0) {
    const ratio = pronounCount / wordCount;
    if (ratio < 0.02) score += 8;
    else if (ratio < 0.04) score += 5;
    else if (ratio < 0.06) score += 3;
  }

  // Named entities — bounded pattern: TitleCase word(s), max 3 words per entity
  const properNouns = text.match(/\b[A-Z][a-z]{1,30}(?:\s+[A-Z][a-z]{1,30}){0,2}\b/g);
  const properNounCount = properNouns ? properNouns.length : 0;
  if (properNounCount >= 3) score += 7;
  else if (properNounCount >= 1) score += 4;

  return Math.min(score, CITABILITY_WEIGHTS.self_containment);
}

function scoreStructuralReadability(text: string, words: string[]): number {
  const wordCount = words.length;
  let score = 0;

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 0) {
    const avgLen = wordCount / sentences.length;
    if (avgLen >= 10 && avgLen <= 20) score += 8;
    else if (avgLen >= 8 && avgLen <= 25) score += 5;
    else score += 2;
  }

  if (/\b(?:first|second|third|finally|additionally|moreover|furthermore)\b/i.test(text)) {
    score += 4;
  }

  if (/(?:\d+[.)]\s|\b(?:step|tip|point)\s+\d+)/i.test(text)) {
    score += 4;
  }

  if (text.includes("\n")) {
    score += 4;
  }

  return Math.min(score, CITABILITY_WEIGHTS.structural_readability);
}

function scoreStatisticalDensity(text: string): number {
  let score = 0;

  // Percentages (bounded decimal)
  const pctMatches = text.match(/\d{1,5}(?:\.\d{1,4})?%/g);
  score += Math.min((pctMatches ? pctMatches.length : 0) * 3, 6);

  // Dollar amounts (bounded currency)
  const dollarMatches = text.match(/\$[\d,]{1,15}(?:\.\d{1,4})?(?:\s*(?:million|billion|M|B|K))?/g);
  score += Math.min((dollarMatches ? dollarMatches.length : 0) * 3, 5);

  // Numbers with context (bounded quantifier list)
  const numContextMatches = text.match(/\b\d{1,10}(?:,\d{3}){0,4}(?:\.\d{1,4})?\s+(?:users|customers|pages|sites|companies|businesses|people|percent|times)\b/gi);
  score += Math.min((numContextMatches ? numContextMatches.length : 0) * 2, 4);

  // Year references (2013–2026)
  const yearMatches = text.match(/\b20(?:1[3-9]|2[0-6])\b/g);
  if (yearMatches && yearMatches.length > 0) score += 2;

  // Named sources
  const sourcePatterns = [
    /\b(?:according to|per|from|by)\s+[A-Z]/,
    /\b(?:Gartner|Forrester|McKinsey|Harvard|Stanford|MIT|Google|Microsoft|OpenAI|Anthropic)\b/,
    /\([A-Z][a-z]{1,30}(?:\s+\d{4})?\)/,
  ];
  for (const pat of sourcePatterns) {
    if (pat.test(text)) {
      score += 2;
      break;
    }
  }

  return Math.min(score, CITABILITY_WEIGHTS.statistical_density);
}

function scoreUniquenessSignals(text: string): number {
  let score = 0;

  if (/\b(?:our\s+(?:research|study|data|analysis|survey|findings)|we\s+(?:found|discovered|analyzed|surveyed|measured))\b/i.test(text)) {
    score += 5;
  }

  if (/\b(?:case\s+study|for\s+example|for\s+instance|in\s+practice|real-world|hands-on)\b/i.test(text)) {
    score += 3;
  }

  // Specific tool mention: "using/with/via/through TitleCase" (bounded)
  if (/\b(?:using|with|via|through)\s+[A-Z][a-z]{1,30}\b/.test(text)) {
    score += 2;
  }

  return Math.min(score, CITABILITY_WEIGHTS.uniqueness_signals);
}

// ---------------------------------------------------------------------------
// Public: scorePassage
// ---------------------------------------------------------------------------

/** Score a single text passage for citability. Returns numeric breakdown. */
export function scorePassage(text: string, heading?: string): PassageResult {
  const words = text.trim() === "" ? [] : text.trim().split(/\s+/);

  const breakdown: Record<CitabilityWeightKey, number> = {
    answer_block_quality: scoreAnswerBlockQuality(text, words, heading),
    self_containment: scoreSelfContainment(text, words),
    structural_readability: scoreStructuralReadability(text, words),
    statistical_density: scoreStatisticalDensity(text),
    uniqueness_signals: scoreUniquenessSignals(text),
  };

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  return {
    heading,
    word_count: words.length,
    total_score: Math.min(total, 100),
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// HTML block extraction (two-pass, bounded regex, ReDoS safe)
// ---------------------------------------------------------------------------

/** Strip noise tags: script, style, svg, path, nav, footer, header, aside, form. */
function stripNoiseTags(html: string): string {
  // Lazy match, bounded: tag name is 2-6 chars. Non-greedy body.
  return html
    .replace(/<script\b[^>]{0,500}>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]{0,500}>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]{0,500}>[\s\S]*?<\/svg>/gi, "")
    .replace(/<path\b[^>]{0,500}>[\s\S]*?<\/path>/gi, "")
    .replace(/<nav\b[^>]{0,500}>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[^>]{0,500}>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header\b[^>]{0,500}>[\s\S]*?<\/header>/gi, "")
    .replace(/<aside\b[^>]{0,500}>[\s\S]*?<\/aside>/gi, "")
    .replace(/<form\b[^>]{0,500}>[\s\S]*?<\/form>/gi, "");
}

/** Extract plain text from a tag's inner content (strip remaining HTML tags). */
function innerText(html: string): string {
  return html
    .replace(/<[^>]{0,500}>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface ContentBlock {
  heading: string | undefined;
  content: string;
}

/**
 * Walk cleaned HTML in source order, pairing headings with following paragraphs/lists.
 * Uses lazy, bounded regex to avoid ReDoS.
 */
function extractContentBlocks(cleanHtml: string): ContentBlock[] {
  // Match heading or content tags lazily; tag attributes bounded to 500 chars
  const tagPattern = /<(h[1-6]|p|ul|ol)\b[^>]{0,500}>([\s\S]*?)<\/\1>/gi;

  const blocks: ContentBlock[] = [];
  let currentHeading: string | undefined = undefined;
  let currentParagraphs: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(cleanHtml)) !== null) {
    const tagName = match[1]!.toLowerCase();
    const rawContent = match[2] ?? "";
    const text = innerText(rawContent);

    if (tagName.startsWith("h")) {
      // Flush previous block
      if (currentParagraphs.length > 0) {
        const combined = currentParagraphs.join(" ");
        if (combined.split(/\s+/).length >= 20) {
          blocks.push({ heading: currentHeading, content: combined });
        }
      }
      currentHeading = text;
      currentParagraphs = [];
    } else {
      // p, ul, ol
      if (text && text.split(/\s+/).length >= 5) {
        currentParagraphs.push(text);
      }
    }
  }

  // Flush final block
  if (currentParagraphs.length > 0) {
    const combined = currentParagraphs.join(" ");
    if (combined.split(/\s+/).length >= 20) {
      blocks.push({ heading: currentHeading, content: combined });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Public: computeCitabilityScore
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic 0–100 citability score for an HTML page.
 * Aggregates per-block scorePassage results. No LLM/network required.
 */
export function computeCitabilityScore(pageData: PageData): CitabilityResult {
  const zeroBreakdown: Record<CitabilityWeightKey, number> = {
    answer_block_quality: 0,
    self_containment: 0,
    structural_readability: 0,
    statistical_density: 0,
    uniqueness_signals: 0,
  };

  const { html } = pageData;

  // Input length guard (T-01-C1)
  if (html.length > MAX_HTML_BYTES) {
    return {
      score: 0,
      breakdown: zeroBreakdown,
      blocksAnalyzed: 0,
      errors: [`HTML input exceeds maximum size (${MAX_HTML_BYTES} bytes)`],
    };
  }

  const trimmed = html.trim();
  if (trimmed.length === 0) {
    return { score: 0, breakdown: zeroBreakdown, blocksAnalyzed: 0, errors: [] };
  }

  const cleanHtml = stripNoiseTags(trimmed);
  const blocks = extractContentBlocks(cleanHtml);

  if (blocks.length === 0) {
    return { score: 0, breakdown: zeroBreakdown, blocksAnalyzed: 0, errors: [] };
  }

  // Aggregate per-block scores — average across all blocks
  const aggregate: Record<CitabilityWeightKey, number> = {
    answer_block_quality: 0,
    self_containment: 0,
    structural_readability: 0,
    statistical_density: 0,
    uniqueness_signals: 0,
  };

  for (const block of blocks) {
    const result = scorePassage(block.content, block.heading);
    for (const key of Object.keys(aggregate) as CitabilityWeightKey[]) {
      aggregate[key] += result.breakdown[key];
    }
  }

  // Clamp each category to its max weight after averaging
  const breakdown: Record<CitabilityWeightKey, number> = {
    answer_block_quality: 0,
    self_containment: 0,
    structural_readability: 0,
    statistical_density: 0,
    uniqueness_signals: 0,
  };

  for (const key of Object.keys(aggregate) as CitabilityWeightKey[]) {
    breakdown[key] = Math.min(
      Math.round(aggregate[key]! / blocks.length),
      CITABILITY_WEIGHTS[key],
    );
  }

  const score = Math.min(
    Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0)),
    100,
  );

  return { score, breakdown, blocksAnalyzed: blocks.length, errors: [] };
}
