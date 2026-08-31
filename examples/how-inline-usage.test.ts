/**
 * CONS-01 offline proof (PROVEN NOW).
 *
 * Asserts the @geo/core inline usage runs with ZERO real network — the injected
 * `fakeFetcher` inside how-inline-usage.ts is the only I/O seam, so this test makes
 * NO real fetch. It verifies structured robots + rendering results come back.
 */

import { describe, it, expect } from "vitest";
import { inlineGeoChecks } from "./how-inline-usage.js";

describe("CONS-01 @geo/core inline usage (offline)", () => {
  it("runs checkRobots + detectRendering with no real network", async () => {
    const html = `<!doctype html><html><body><main><h1>Hi</h1>
      <p>${"server rendered prose ".repeat(40)}</p></main>
      <script src="/a.js"></script></body></html>`;

    const { robots, rendering } = await inlineGeoChecks("https://example.com", html);

    // robots: aiCrawlerStatus is keyed by every AI crawler; GPTBot must be defined.
    expect(robots.aiCrawlerStatus.GPTBot).toBeDefined();
    // Canned robots.txt blocks GPTBot with Disallow: / .
    expect(robots.aiCrawlerStatus.GPTBot).toBe("BLOCKED");
    expect(robots.exists).toBe(true);
    expect(robots.sitemaps).toContain("https://example.com/sitemap.xml");

    // rendering: classification is one of the three legal values.
    expect(["ssr", "csr", "hybrid"]).toContain(rendering.rendering);
    // Text-rich, low-script HTML → SSR.
    expect(rendering.rendering).toBe("ssr");
    expect(rendering.wordCount).toBeGreaterThan(0);
  });
});
