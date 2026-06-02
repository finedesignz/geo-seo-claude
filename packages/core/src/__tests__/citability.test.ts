/**
 * citability.test.ts — TDD RED phase for CORE-04
 * Tests: weights sum, ordering (rich > vague), clamping, aggregate, determinism, edge cases, ReDoS guard.
 */
import { describe, it, expect } from "vitest";
import {
  CITABILITY_WEIGHTS,
  computeCitabilityScore,
  scorePassage,
} from "../citability.js";

// ---------------------------------------------------------------------------
// 1. Weights integrity
// ---------------------------------------------------------------------------
describe("CITABILITY_WEIGHTS", () => {
  it("values sum to exactly 100", () => {
    const total = Object.values(CITABILITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it("has exactly the five expected keys", () => {
    expect(Object.keys(CITABILITY_WEIGHTS).sort()).toEqual([
      "answer_block_quality",
      "self_containment",
      "statistical_density",
      "structural_readability",
      "uniqueness_signals",
    ]);
  });

  it("is frozen / not mutatable at runtime", () => {
    // `as const` gives readonly TS — we also freeze at runtime
    expect(() => {
      // @ts-expect-error intentional mutation attempt
      (CITABILITY_WEIGHTS as Record<string, number>).answer_block_quality = 999;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. scorePassage — ordering and clamping
// ---------------------------------------------------------------------------
describe("scorePassage", () => {
  const richPassage = `
    According to research by Google, websites that implement structured data experience
    a 32% increase in click-through rates. Our analysis of 1,200 sites in 2024 found
    that schema markup improves GEO scores by 45%. Using Schema.org allows search engines
    to extract factual, self-contained answers. First, implement JSON-LD. Second, validate
    with the Rich Results Test. Finally, monitor impressions in Search Console.
    Organizations that adopt these practices report measurable improvements in AI citation
    frequency. The optimal passage length is 134 to 167 words for AI model citation.
  `.trim();

  const vaguePassage = "It helps them do things better.";

  it("rich passage scores higher than vague passage", () => {
    const rich = scorePassage(richPassage);
    const vague = scorePassage(vaguePassage);
    expect(rich.total_score).toBeGreaterThan(vague.total_score);
  });

  it("each sub-score is clamped to its weight max", () => {
    const result = scorePassage(richPassage);
    expect(result.breakdown.answer_block_quality).toBeLessThanOrEqual(CITABILITY_WEIGHTS.answer_block_quality);
    expect(result.breakdown.self_containment).toBeLessThanOrEqual(CITABILITY_WEIGHTS.self_containment);
    expect(result.breakdown.structural_readability).toBeLessThanOrEqual(CITABILITY_WEIGHTS.structural_readability);
    expect(result.breakdown.statistical_density).toBeLessThanOrEqual(CITABILITY_WEIGHTS.statistical_density);
    expect(result.breakdown.uniqueness_signals).toBeLessThanOrEqual(CITABILITY_WEIGHTS.uniqueness_signals);
  });

  it("total_score is bounded 0–100", () => {
    const r = scorePassage(richPassage);
    expect(r.total_score).toBeGreaterThanOrEqual(0);
    expect(r.total_score).toBeLessThanOrEqual(100);
  });

  it("question heading adds bonus", () => {
    const withQ = scorePassage(richPassage, "What is schema markup?");
    const withoutQ = scorePassage(richPassage);
    expect(withQ.total_score).toBeGreaterThanOrEqual(withoutQ.total_score);
  });

  it("empty text returns score 0 and all-zero breakdown", () => {
    const result = scorePassage("");
    expect(result.total_score).toBe(0);
    for (const v of Object.values(result.breakdown)) {
      expect(v).toBe(0);
    }
  });

  it("determinism — identical input produces identical score", () => {
    const a = scorePassage(richPassage, "Does it work?");
    const b = scorePassage(richPassage, "Does it work?");
    expect(a.total_score).toBe(b.total_score);
    expect(a.breakdown).toEqual(b.breakdown);
  });
});

// ---------------------------------------------------------------------------
// 3. computeCitabilityScore — aggregate over HTML
// ---------------------------------------------------------------------------
describe("computeCitabilityScore", () => {
  const goodHtml = `
    <html><body>
      <h2>What is schema markup?</h2>
      <p>According to research by Google, websites that implement structured data experience
      a 32% increase in click-through rates. Our analysis of 1,200 sites in 2024 found
      that schema markup improves GEO scores by 45%. Using Schema.org allows search engines
      to extract factual, self-contained answers. First, implement JSON-LD. Second, validate
      with the Rich Results Test. Finally, monitor impressions in Search Console.</p>
      <h3>Implementation Steps</h3>
      <p>Organizations that adopt these practices report measurable improvements in AI citation
      frequency. The optimal passage length is 134 to 167 words for AI model citation.
      Data from Stanford shows 78% of AI citations reference passages under 200 words.</p>
    </body></html>
  `;

  it("returns score in 0–100 range", () => {
    const result = computeCitabilityScore({ html: goodHtml });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("returns all five breakdown keys", () => {
    const result = computeCitabilityScore({ html: goodHtml });
    expect(Object.keys(result.breakdown).sort()).toEqual([
      "answer_block_quality",
      "self_containment",
      "statistical_density",
      "structural_readability",
      "uniqueness_signals",
    ]);
  });

  it("blocksAnalyzed reflects extracted content blocks", () => {
    const result = computeCitabilityScore({ html: goodHtml });
    expect(result.blocksAnalyzed).toBeGreaterThan(0);
  });

  it("empty HTML → score 0, breakdown all zeros, errors empty, no throw", () => {
    const result = computeCitabilityScore({ html: "" });
    expect(result.score).toBe(0);
    for (const v of Object.values(result.breakdown)) {
      expect(v).toBe(0);
    }
    expect(result.errors).toEqual([]);
    expect(result.blocksAnalyzed).toBe(0);
  });

  it("whitespace-only HTML → score 0, no throw", () => {
    const result = computeCitabilityScore({ html: "   \n\t  " });
    expect(result.score).toBe(0);
  });

  it("determinism — same HTML, same score", () => {
    const a = computeCitabilityScore({ html: goodHtml });
    const b = computeCitabilityScore({ html: goodHtml });
    expect(a.score).toBe(b.score);
    expect(a.breakdown).toEqual(b.breakdown);
  });

  it("script/style/nav/footer content is stripped before scoring", () => {
    const htmlWithNoise = `
      <html><body>
        <script>var x = 'according to research by Google, 32% increase';</script>
        <style>.foo { content: "research shows 45%"; }</style>
        <nav>First step second step according to research</nav>
        <footer>Copyright 2024 Google</footer>
        <p>Simple unstructured content here with no statistics or clear patterns.</p>
      </body></html>
    `;
    const noiseResult = computeCitabilityScore({ html: htmlWithNoise });
    // Score should be low — noise tags stripped, only the weak <p> remains
    expect(noiseResult.score).toBeLessThan(30);
  });

  it("oversized HTML (>5MB) returns error, no throw", () => {
    const huge = "a".repeat(5 * 1024 * 1024 + 1);
    const result = computeCitabilityScore({ html: huge });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.score).toBe(0);
  });

  it("ReDoS guard — pathological nested-quantifier input completes quickly", () => {
    // Pathological input: a string that could cause catastrophic backtracking
    // in naive nested quantifier regex (e.g. (a+)+ pattern)
    const pathological = "a".repeat(30) + "X" + "a".repeat(30) + "!".repeat(100);
    const start = Date.now();
    computeCitabilityScore({ html: `<p>${pathological}</p>` });
    const elapsed = Date.now() - start;
    // Should complete in well under 1 second (generous bound)
    expect(elapsed).toBeLessThan(1000);
  });
});
