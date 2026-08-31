import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getSchemaTemplates,
  validateStructuredData,
  SCHEMA_TYPES,
  MAX_HTML_BYTES,
} from "../schema.js";
import type { SchemaType } from "../schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// getSchemaTemplates
// ---------------------------------------------------------------------------

describe("getSchemaTemplates", () => {
  it("returns Organization template with correct @type and required fields", () => {
    const t = getSchemaTemplates("Organization");
    expect(t["@context"]).toBe("https://schema.org");
    expect(t["@type"]).toBe("Organization");
    expect(t).toHaveProperty("name");
    expect(t).toHaveProperty("url");
  });

  it("covers all six schema types — each returns template with matching @type", () => {
    for (const type of SCHEMA_TYPES) {
      const t = getSchemaTemplates(type as SchemaType);
      expect(t["@type"]).toBe(type);
      expect(t["@context"]).toBe("https://schema.org");
    }
  });

  it("WebSite template has potentialAction", () => {
    const t = getSchemaTemplates("WebSite");
    expect(t).toHaveProperty("potentialAction");
  });

  it("Article template has headline, datePublished, author", () => {
    const t = getSchemaTemplates("Article");
    expect(t).toHaveProperty("headline");
    expect(t).toHaveProperty("datePublished");
    expect(t).toHaveProperty("author");
  });

  it("Product template has name and offers", () => {
    const t = getSchemaTemplates("Product");
    expect(t).toHaveProperty("name");
    expect(t).toHaveProperty("offers");
  });

  it("BreadcrumbList template has itemListElement", () => {
    const t = getSchemaTemplates("BreadcrumbList");
    expect(t).toHaveProperty("itemListElement");
    expect(Array.isArray(t["itemListElement"])).toBe(true);
  });

  it("FAQPage template has mainEntity", () => {
    const t = getSchemaTemplates("FAQPage");
    expect(t).toHaveProperty("mainEntity");
    expect(Array.isArray(t["mainEntity"])).toBe(true);
  });

  it("returns a new object each call (no shared reference)", () => {
    const a = getSchemaTemplates("Organization");
    const b = getSchemaTemplates("Organization");
    expect(a).not.toBe(b);
  });

  it("throws on unknown type literal (programmer error)", () => {
    // @ts-expect-error — testing invalid input
    expect(() => getSchemaTemplates("UnknownType")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateStructuredData — schema-rich fixture
// ---------------------------------------------------------------------------

describe("validateStructuredData — schema-rich fixture", () => {
  let html: string;

  beforeEach(() => {
    html = loadFixture("schema-rich.html");
  });

  it("returns jsonLdCount >= 1", () => {
    const result = validateStructuredData(html);
    expect(result.jsonLdCount).toBeGreaterThanOrEqual(1);
  });

  it("found contains Organization with valid:true", () => {
    const result = validateStructuredData(html);
    const org = result.found.find((f) => f.type === "Organization");
    expect(org).toBeDefined();
    expect(org?.valid).toBe(true);
  });

  it("found contains Article with valid:true", () => {
    const result = validateStructuredData(html);
    const article = result.found.find((f) => f.type === "Article");
    expect(article).toBeDefined();
    expect(article?.valid).toBe(true);
  });

  it("errors array is empty for well-formed fixture", () => {
    const result = validateStructuredData(html);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateStructuredData — schema-none fixture
// ---------------------------------------------------------------------------

describe("validateStructuredData — schema-none fixture", () => {
  let html: string;

  beforeEach(() => {
    html = loadFixture("schema-none.html");
  });

  it("returns jsonLdCount:0, found:[], errors:[]", () => {
    const result = validateStructuredData(html);
    expect(result.jsonLdCount).toBe(0);
    expect(result.found).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateStructuredData — malformed JSON-LD
// ---------------------------------------------------------------------------

describe("validateStructuredData — malformed JSON-LD", () => {
  it("does not throw on invalid JSON", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ this is not valid json }</script>
    </head></html>`;
    expect(() => validateStructuredData(html)).not.toThrow();
  });

  it("records an error entry for the invalid block", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ bad json }</script>
    </head></html>`;
    const result = validateStructuredData(html);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/parse/i);
  });

  it("continues processing valid blocks after a malformed one", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ bad }</script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Test","url":"https://test.com"}</script>
    </head></html>`;
    const result = validateStructuredData(html);
    expect(result.jsonLdCount).toBe(1);
    const org = result.found.find((f) => f.type === "Organization");
    expect(org).toBeDefined();
    expect(org?.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateStructuredData — prototype pollution guard (T-01-S2)
// ---------------------------------------------------------------------------

describe("validateStructuredData — prototype pollution", () => {
  it("does not pollute Object.prototype via __proto__ key", () => {
    // Ensure clean state.
    expect((({}) as Record<string, unknown>)["polluted"]).toBeUndefined();

    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Test","url":"https://test.com","__proto__":{"polluted":true}}</script>
    </head></html>`;
    validateStructuredData(html);

    // Object.prototype must remain clean.
    expect((({}) as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("does not pollute Object.prototype via constructor.prototype attack", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Test","url":"https://test.com","constructor":{"prototype":{"polluted2":true}}}</script>
    </head></html>`;
    validateStructuredData(html);
    expect((({}) as Record<string, unknown>)["polluted2"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateStructuredData — edge cases
// ---------------------------------------------------------------------------

describe("validateStructuredData — edge cases", () => {
  it("handles @graph wrapper", () => {
    const html = `<html><head>
      <script type="application/ld+json">{
        "@context": "https://schema.org",
        "@graph": [
          {"@type": "Organization", "name": "Org", "url": "https://org.com"},
          {"@type": "WebSite", "name": "Site", "url": "https://site.com"}
        ]
      }</script>
    </head></html>`;
    const result = validateStructuredData(html);
    expect(result.jsonLdCount).toBe(1);
    expect(result.found.find((f) => f.type === "Organization")).toBeDefined();
    expect(result.found.find((f) => f.type === "WebSite")).toBeDefined();
  });

  it("handles array of @type", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":["Organization","LocalBusiness"],"name":"Dual","url":"https://dual.com"}</script>
    </head></html>`;
    const result = validateStructuredData(html);
    expect(result.found.find((f) => f.type === "Organization")).toBeDefined();
    expect(result.found.find((f) => f.type === "LocalBusiness")).toBeDefined();
  });

  it("handles top-level array of objects", () => {
    const html = `<html><head>
      <script type="application/ld+json">[
        {"@context":"https://schema.org","@type":"Organization","name":"Org","url":"https://org.com"},
        {"@context":"https://schema.org","@type":"WebSite","name":"Site","url":"https://site.com"}
      ]</script>
    </head></html>`;
    const result = validateStructuredData(html);
    expect(result.jsonLdCount).toBe(1);
    expect(result.found.length).toBe(2);
  });

  it("handles unknown @type without degrading known types", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"SomeUnknownType","name":"Test"}</script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Known","url":"https://known.com"}</script>
    </head></html>`;
    const result = validateStructuredData(html);
    const org = result.found.find((f) => f.type === "Organization");
    expect(org).toBeDefined();
    expect(org?.valid).toBe(true);
  });

  it("reports missingFields for incomplete schema", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Title"}</script>
    </head></html>`;
    const result = validateStructuredData(html);
    const article = result.found.find((f) => f.type === "Article");
    expect(article).toBeDefined();
    expect(article?.valid).toBe(false);
    expect(article?.missingFields).toContain("datePublished");
    expect(article?.missingFields).toContain("author");
  });

  it("handles HTML exceeding MAX_HTML_BYTES with an error and no results", () => {
    const oversized = "x".repeat(MAX_HTML_BYTES + 1);
    const result = validateStructuredData(oversized);
    expect(result.jsonLdCount).toBe(0);
    expect(result.found).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Barrel export smoke test
// ---------------------------------------------------------------------------

describe("barrel exports", () => {
  it("getSchemaTemplates is importable from barrel", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof mod.getSchemaTemplates).toBe("function");
  });

  it("validateStructuredData is importable from barrel", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof mod.validateStructuredData).toBe("function");
  });
});
