import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRendering } from "../rendering.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../../fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const csrHtml = loadFixture("csr-page.html");
const ssrHtml = loadFixture("ssr-page.html");

// ---------------------------------------------------------------------------
// Fixture classification
// ---------------------------------------------------------------------------

describe("detectRendering — CSR fixture", () => {
  it('returns rendering: "csr"', () => {
    const result = detectRendering(csrHtml);
    expect(result.rendering).toBe("csr");
  });

  it("has non-empty signals", () => {
    const result = detectRendering(csrHtml);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("confidence in [0, 1]", () => {
    const result = detectRendering(csrHtml);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("reports scriptCount and wordCount", () => {
    const result = detectRendering(csrHtml);
    expect(result.scriptCount).toBeGreaterThan(0);
    expect(typeof result.wordCount).toBe("number");
  });
});

describe("detectRendering — SSR fixture", () => {
  it('returns rendering: "ssr"', () => {
    const result = detectRendering(ssrHtml);
    expect(result.rendering).toBe("ssr");
  });

  it("has non-empty signals", () => {
    const result = detectRendering(ssrHtml);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("confidence in [0, 1]", () => {
    const result = detectRendering(ssrHtml);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Python single-threshold bug fix: large-copy SPA must not be mis-classified as SSR
// ---------------------------------------------------------------------------

describe("detectRendering — Python bug fix (large-copy SPA)", () => {
  const largeCopyCsrHtml = `<!DOCTYPE html>
<html>
<head><title>SPA Shell</title></head>
<body>
  <div id="root"></div>
  <script src="/static/js/main.js"></script>
  <script src="/static/js/vendors.js"></script>
  <script src="/static/js/runtime.js"></script>
  <script>window.__NEXT_DATA__ = { props: {} };</script>
  <p>This is a large static marketing copy section that exists on the shell page to prevent SSO misclas.</p>
  <p>We have lots of words here intentionally to simulate a SPA shell with static copy in the HTML, but the actual dynamic content is loaded via JavaScript into the root div. The important thing is that the framework root div is empty and there are hydration markers present, which should override the word count signal.</p>
  <p>Even more words to push past the 200-word threshold that the Python code used as a single gating factor. This was the bug — it required BOTH low root text AND low word count, causing large-copy SPAs to be incorrectly classified as SSR. Our multi-signal approach correctly identifies CSR here.</p>
</body>
</html>`;

  it('returns "csr" or "hybrid" (NOT "ssr") for large-copy SPA shell', () => {
    const result = detectRendering(largeCopyCsrHtml);
    expect(result.rendering).not.toBe("ssr");
  });

  it("includes framework-root-div in signals", () => {
    const result = detectRendering(largeCopyCsrHtml);
    expect(result.signals).toContain("framework-root-div");
  });
});

// ---------------------------------------------------------------------------
// Framework hydration marker signals
// ---------------------------------------------------------------------------

describe("detectRendering — hydration markers", () => {
  it("detects __NEXT_DATA__ as strong CSR marker", () => {
    const html = `<html><body><div id="root"></div><script>window.__NEXT_DATA__={}</script></body></html>`;
    const result = detectRendering(html);
    expect(result.signals.some((s) => s.includes("__NEXT_DATA__"))).toBe(true);
    expect(result.rendering).toBe("csr");
  });

  it("detects v-cloak as strong CSR marker", () => {
    const html = `<html><body><div id="app" v-cloak></div><script src="vue.js"></script><script src="app.js"></script></body></html>`;
    const result = detectRendering(html);
    expect(result.signals.some((s) => s.includes("v-cloak"))).toBe(true);
  });

  it("detects data-server-rendered as SSR confirmation", () => {
    const html = `<html><body data-server-rendered="true"><h1>Hello</h1><p>Server content here. More text. Even more words to make this clearly text-rich.</p></body></html>`;
    const result = detectRendering(html);
    expect(result.signals.some((s) => s.includes("ssr-confirmed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectRendering — edge cases", () => {
  it("empty string returns a result with no throw", () => {
    const result = detectRendering("");
    expect(result).toBeDefined();
    expect(result.rendering).toBeDefined();
    expect(result.errors).toEqual([]);
  });

  it("whitespace-only HTML returns a result with no throw", () => {
    const result = detectRendering("   \n\t  ");
    expect(result).toBeDefined();
  });

  it("determinism — identical HTML yields identical result", () => {
    const html = `<html><body><div id="root"></div><script>window.__NEXT_DATA__={}</script></body></html>`;
    const r1 = detectRendering(html);
    const r2 = detectRendering(html);
    expect(r1.rendering).toBe(r2.rendering);
    expect(r1.confidence).toBe(r2.confidence);
    expect(r1.signals).toEqual(r2.signals);
    expect(r1.wordCount).toBe(r2.wordCount);
    expect(r1.scriptCount).toBe(r2.scriptCount);
  });

  it("oversized HTML is truncated and returns no throw", () => {
    const bigHtml = "a".repeat(6 * 1024 * 1024);
    const result = detectRendering(bigHtml);
    expect(result).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("truncated");
  });
});
