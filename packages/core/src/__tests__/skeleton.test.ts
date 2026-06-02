import { describe, it, expect } from "vitest";
import { FetchResult, Fetcher, AI_CRAWLERS, normalizeUrl } from "../index";

describe("@geo/core barrel exports", () => {
  it("exports AI_CRAWLERS including GPTBot and ClaudeBot", () => {
    expect(AI_CRAWLERS).toContain("GPTBot");
    expect(AI_CRAWLERS).toContain("ClaudeBot");
  });

  it("normalizeUrl returns normalized href for valid https URL", () => {
    const result = normalizeUrl("https://example.com");
    expect(result.errors).toHaveLength(0);
    expect(result.url).toBe("https://example.com/");
  });

  it("normalizeUrl does not throw for invalid input — D-06 result-accumulation", () => {
    const result = normalizeUrl("not a url");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.url).toBe("");
  });

  it("FetchResult and Fetcher types are exported (compile-time check via usage)", () => {
    // Type-level test: if these assignments compile, the types are exported correctly
    const result: FetchResult = {
      url: "https://example.com",
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html></html>",
      redirectChain: [],
    };
    const fetcher: Fetcher = async (_url: string): Promise<FetchResult> => result;
    expect(result.url).toBe("https://example.com");
    expect(typeof fetcher).toBe("function");
  });
});
