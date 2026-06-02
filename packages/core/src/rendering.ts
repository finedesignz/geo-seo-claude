/**
 * @geo/core — detectRendering (CORE-05)
 *
 * Classifies raw HTML as ssr | csr | hybrid using a multi-signal heuristic.
 * Fixes the Python brittle single-boolean threshold bug (large-copy SPA shells
 * still flagged CSR when framework root + hydration markers present).
 *
 * Security: input-length guard (~5MB) before regex passes (T-01-D1).
 * Zero runtime deps. No throw for expected failure states (D-06).
 */

import type { RenderingResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5MB guard

/** Framework hydration markers that indicate a JS-driven render lifecycle. */
export const HYDRATION_MARKERS = [
  "__NEXT_DATA__",        // Next.js
  "data-reactroot",       // React (older SSR marker — but presence alone is ambiguous)
  "ng-version",           // Angular
  "__NUXT_DATA__",        // Nuxt
  "data-server-rendered", // Nuxt SSR explicit flag
  "__svelte",             // Svelte
  "x-data",               // Alpine.js (CSR)
  "v-cloak",              // Vue CSR: element hidden until Vue instance mounts
] as const;

/** IDs that indicate a JS framework root container. */
export const FRAMEWORK_ROOT_PATTERN = /id=["'](?:app|root|__next|__nuxt)["']/i;

/**
 * Hydration markers that are strong CSR indicators (app renders into these containers
 * and they are typically empty in a CSR shell).
 */
const CSR_STRONG_MARKERS = new Set(["v-cloak", "x-data", "__NUXT_DATA__", "__NEXT_DATA__"]);

/**
 * Server-render confirmation markers — presence alongside text-rich HTML is strong SSR.
 * Note: `data-server-rendered` is Nuxt's explicit flag for "I pre-rendered this".
 */
const SSR_CONFIRMATION_MARKERS = new Set(["data-server-rendered"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip script and style blocks (lazy to avoid ReDoS), then strip remaining tags. */
function extractVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

/** Count words in a text string (split on whitespace, filter empty). */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Estimate inner-text length of the primary framework root div.
 * Returns 0 if no framework root found.
 *
 * We look for `<div id="root"|"app"|"__next"|"__nuxt"` and capture everything
 * until `</div` (lazy). This is a heuristic — nested divs will truncate early,
 * but that's fine: we only need to know if the root is effectively empty.
 */
function getRootDivTextLength(html: string): number {
  const rootMatch = /<div[^>]+id=["'](?:app|root|__next|__nuxt)["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (!rootMatch || !rootMatch[1]) return 0;
  // Strip any nested tags to get raw text
  const inner = rootMatch[1].replace(/<[^>]+>/g, " ").trim();
  return inner.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify raw HTML as `ssr`, `csr`, or `hybrid`.
 *
 * Signal scoring (higher = more CSR):
 *  +3 framework root div present
 *  +2 per strong CSR hydration marker (v-cloak, x-data, __NUXT_DATA__, __NEXT_DATA__)
 *  +1 per other hydration marker
 *  +2 high script count (≥ 3)
 *  +1 moderate script count (2)
 *  +2 root div is empty / near-empty (< 50 chars)
 *  -3 SSR confirmation marker (data-server-rendered)
 *  -1 per 100 words visible text (up to -4, diminishing returns)
 *
 * Classification:
 *  csrScore ≥ 5 → csr (unless SSR confirmation markers anchor it)
 *  csrScore ≤ 1 → ssr
 *  2–4 → hybrid
 *
 * @param html - Raw HTML string from the initial page response.
 */
export function detectRendering(html: string): RenderingResult {
  const errors: string[] = [];
  const signals: string[] = [];

  // Input guard (T-01-D1)
  if (html.length > MAX_HTML_BYTES) {
    errors.push(`html truncated: ${html.length} bytes exceeds ${MAX_HTML_BYTES} limit`);
    html = html.slice(0, MAX_HTML_BYTES);
  }

  // Handle empty / trivial input
  if (html.trim().length === 0) {
    return {
      rendering: "csr",
      confidence: 0.5,
      signals: ["empty-html"],
      wordCount: 0,
      scriptCount: 0,
      errors,
    };
  }

  // --- Compute raw metrics BEFORE stripping (Pitfall 3: extract structured data first) ---
  const scriptCount = (html.match(/<script/gi) ?? []).length;
  const hasFrameworkRoot = FRAMEWORK_ROOT_PATTERN.test(html);
  const matchedMarkers = HYDRATION_MARKERS.filter((m) => html.includes(m));
  const rootDivTextLength = hasFrameworkRoot ? getRootDivTextLength(html) : -1;

  // Visible text / word count (strip scripts+styles first, then tags)
  const visibleText = extractVisibleText(html);
  const wordCount = countWords(visibleText);

  // --- Score signals ---
  let csrScore = 0;

  if (hasFrameworkRoot) {
    csrScore += 3;
    signals.push("framework-root-div");
  }

  for (const marker of matchedMarkers) {
    if (CSR_STRONG_MARKERS.has(marker)) {
      csrScore += 2;
      signals.push(`hydration-marker:${marker}:strong-csr`);
    } else if (SSR_CONFIRMATION_MARKERS.has(marker)) {
      csrScore -= 3;
      signals.push(`hydration-marker:${marker}:ssr-confirmed`);
    } else {
      csrScore += 1;
      signals.push(`hydration-marker:${marker}`);
    }
  }

  if (scriptCount >= 3) {
    csrScore += 2;
    signals.push(`high-script-count:${scriptCount}`);
  } else if (scriptCount >= 2) {
    csrScore += 1;
    signals.push(`moderate-script-count:${scriptCount}`);
  }

  if (rootDivTextLength >= 0) {
    if (rootDivTextLength < 50) {
      csrScore += 2;
      signals.push("low-root-text");
    } else {
      signals.push(`root-text-present:${rootDivTextLength}`);
    }
  }

  // Word count signal — always emitted so signals is non-empty even for plain SSR pages.
  // Large copy alone must NOT mask CSR markers (Python bug fix: we do NOT require both
  // low word count AND low root text together).
  if (wordCount > 300) {
    csrScore -= 1;
    signals.push(`high-word-count:${wordCount}`);
  } else if (wordCount >= 50) {
    signals.push(`word-count:${wordCount}`);
  } else {
    csrScore += 1;
    signals.push(`low-word-count:${wordCount}`);
  }

  // --- Classify ---
  let rendering: RenderingResult["rendering"];
  let confidence: number;

  if (csrScore >= 5) {
    rendering = "csr";
    confidence = Math.min(0.95, 0.5 + csrScore * 0.05);
  } else if (csrScore <= 1) {
    rendering = "ssr";
    confidence = Math.min(0.95, 0.5 + (2 - csrScore) * 0.1);
  } else {
    rendering = "hybrid";
    // confidence reflects proximity to a clear boundary
    confidence = 0.4 + Math.abs(csrScore - 3) * 0.05;
  }

  // Clamp confidence to [0, 1]
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    rendering,
    confidence,
    signals,
    wordCount,
    scriptCount,
    errors,
  };
}
