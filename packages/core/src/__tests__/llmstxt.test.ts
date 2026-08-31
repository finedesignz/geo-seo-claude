import { describe, it, expect } from "vitest";
import { generateLlmsTxt, validateLlmsTxt } from "../llmstxt.js";
import type { CrawlData } from "../llmstxt.js";
import { readFileSync } from "fs";
import { join } from "path";

const validFixture = readFileSync(
  join(__dirname, "../../fixtures/llmstxt-valid.txt"),
  "utf-8"
);

// ---------------------------------------------------------------------------
// generateLlmsTxt
// ---------------------------------------------------------------------------

describe("generateLlmsTxt", () => {
  const baseCrawl: CrawlData = {
    siteName: "Acme Corp",
    siteUrl: "https://acme.com",
    description: "AI-powered tools for modern teams.",
    pages: [
      {
        title: "API Reference",
        url: "https://acme.com/docs/api",
        description: "Full REST API docs.",
        section: "Docs",
      },
      {
        title: "Getting Started",
        url: "https://acme.com/docs/start",
        section: "Docs",
      },
    ],
  };

  it("starts with # title line", () => {
    const out = generateLlmsTxt(baseCrawl);
    expect(out.startsWith("# Acme Corp")).toBe(true);
  });

  it("includes > description blockquote", () => {
    const out = generateLlmsTxt(baseCrawl);
    expect(out).toContain("> AI-powered tools for modern teams.");
  });

  it("includes ## Docs section heading", () => {
    const out = generateLlmsTxt(baseCrawl);
    expect(out).toContain("## Docs");
  });

  it("includes link entries in [Title](url) format", () => {
    const out = generateLlmsTxt(baseCrawl);
    expect(out).toContain("- [API Reference](https://acme.com/docs/api): Full REST API docs.");
    expect(out).toContain("- [Getting Started](https://acme.com/docs/start)");
  });

  it("omits : description when page description absent", () => {
    const out = generateLlmsTxt(baseCrawl);
    // Getting Started has no description — must not have trailing ": "
    expect(out).not.toMatch(/\[Getting Started\]\(.*\): $/m);
  });

  it("groups pages without section under default uncategorized section", () => {
    const crawl: CrawlData = {
      siteName: "Test",
      siteUrl: "https://test.com",
      pages: [{ title: "Home", url: "https://test.com/" }],
    };
    const out = generateLlmsTxt(crawl);
    expect(out).toContain("## Pages");
    expect(out).toContain("- [Home](https://test.com/)");
  });

  it("is deterministic — identical input yields byte-identical output", () => {
    const a = generateLlmsTxt(baseCrawl);
    const b = generateLlmsTxt(baseCrawl);
    expect(a).toBe(b);
  });

  it("emits ## Contact section when contact provided", () => {
    const crawl: CrawlData = {
      ...baseCrawl,
      contact: { website: "https://acme.com", email: "hi@acme.com" },
    };
    const out = generateLlmsTxt(crawl);
    expect(out).toContain("## Contact");
    expect(out).toContain("https://acme.com");
    expect(out).toContain("hi@acme.com");
  });

  it("preserves first-seen section order across pages", () => {
    const crawl: CrawlData = {
      siteName: "Ordered",
      siteUrl: "https://ordered.com",
      pages: [
        { title: "A1", url: "https://ordered.com/a1", section: "Alpha" },
        { title: "B1", url: "https://ordered.com/b1", section: "Beta" },
        { title: "A2", url: "https://ordered.com/a2", section: "Alpha" },
      ],
    };
    const out = generateLlmsTxt(crawl);
    const alphaIdx = out.indexOf("## Alpha");
    const betaIdx = out.indexOf("## Beta");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
  });

  it("escapes ] and ) in titles/descriptions to avoid Markdown link corruption", () => {
    const crawl: CrawlData = {
      siteName: "Escape Test",
      siteUrl: "https://escape.com",
      pages: [
        {
          title: "Part [1] guide",
          url: "https://escape.com/p1",
          description: "Covers (all) cases.",
          section: "Guide",
        },
      ],
    };
    const out = generateLlmsTxt(crawl);
    // The link title must not break the [...](url) structure
    // Escaped ] inside link text → \]
    expect(out).toContain("[Part \\[1\\] guide]");
  });
});

// ---------------------------------------------------------------------------
// validateLlmsTxt
// ---------------------------------------------------------------------------

describe("validateLlmsTxt", () => {
  it("validates the committed valid fixture as valid with no errors", () => {
    const result = validateLlmsTxt(validFixture);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.hasTitle).toBe(true);
    expect(result.hasDescription).toBe(true);
    expect(result.sectionCount).toBeGreaterThan(0);
    expect(result.linkCount).toBeGreaterThan(0);
  });

  it("returns valid:false and an error when title line missing", () => {
    const noTitle = "> some description\n\n## Docs\n\n- [Page](https://x.com)";
    const result = validateLlmsTxt(noTitle);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.toLowerCase()).toContain("title");
  });

  it("returns valid:true for title-only text (A4: only title is mandatory)", () => {
    const titleOnly = "# My Site\n";
    const result = validateLlmsTxt(titleOnly);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("adds warnings for missing description on title-only text", () => {
    const titleOnly = "# My Site\n";
    const result = validateLlmsTxt(titleOnly);
    expect(result.warnings.length).toBeGreaterThan(0);
    const w = result.warnings.join(" ").toLowerCase();
    expect(w).toContain("description");
  });

  it("counts sections correctly", () => {
    const text = "# Site\n\n> desc\n\n## Alpha\n\n- [A](https://a.com)\n\n## Beta\n\n- [B](https://b.com)\n";
    const result = validateLlmsTxt(text);
    expect(result.sectionCount).toBe(2);
  });

  it("counts links correctly", () => {
    const text = "# Site\n\n## Section\n\n- [A](https://a.com)\n- [B](https://b.com): desc\n";
    const result = validateLlmsTxt(text);
    expect(result.linkCount).toBe(2);
  });

  it("does not throw on empty string", () => {
    expect(() => validateLlmsTxt("")).not.toThrow();
    const result = validateLlmsTxt("");
    expect(result.valid).toBe(false);
  });
});
