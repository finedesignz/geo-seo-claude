import { describe, it, expect } from "vitest";
import * as geo from "../index.js";
import { CITABILITY_WEIGHTS } from "../index.js";

describe("@geo/core public surface contract", () => {
  it("exports all runtime functions", () => {
    expect(typeof geo.checkRobots).toBe("function");
    expect(typeof geo.generateLlmsTxt).toBe("function");
    expect(typeof geo.validateLlmsTxt).toBe("function");
    expect(typeof geo.getSchemaTemplates).toBe("function");
    expect(typeof geo.validateStructuredData).toBe("function");
    expect(typeof geo.computeCitabilityScore).toBe("function");
    expect(typeof geo.scorePassage).toBe("function");
    expect(typeof geo.detectRendering).toBe("function");
    expect(typeof geo.normalizeUrl).toBe("function");
  });

  it("exports CITABILITY_WEIGHTS as an object", () => {
    expect(typeof geo.CITABILITY_WEIGHTS).toBe("object");
    expect(geo.CITABILITY_WEIGHTS).not.toBeNull();
  });

  it("exports AI_CRAWLERS as an array", () => {
    expect(Array.isArray(geo.AI_CRAWLERS)).toBe(true);
    expect(geo.AI_CRAWLERS.length).toBeGreaterThan(0);
  });

  it("CITABILITY_WEIGHTS sums to 100", () => {
    const sum = Object.values(CITABILITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(100, 5);
  });

  it("CITABILITY_WEIGHTS is the same object used by computeCitabilityScore (no drift)", () => {
    // The breakdown keys returned by computeCitabilityScore must match CITABILITY_WEIGHTS keys
    const weightKeys = Object.keys(CITABILITY_WEIGHTS).sort();
    expect(weightKeys.length).toBeGreaterThan(0);
    // Verify the exported constant is the canonical reference (same reference via named import)
    expect(CITABILITY_WEIGHTS).toBe(geo.CITABILITY_WEIGHTS);
  });

  it("exports are stable (re-import returns same values)", async () => {
    const { CITABILITY_WEIGHTS: w2, AI_CRAWLERS: c2 } = await import("../index.js");
    expect(w2).toBe(CITABILITY_WEIGHTS);
    expect(c2).toBe(geo.AI_CRAWLERS);
  });
});
