/**
 * CONS-01 — @geo/core INLINE (no-HTTP) usage example.
 *
 * This is the pattern the `hyperoptimizedwebsites` (HOW) consumer uses: HOW already
 * has the page HTML and robots.txt in hand from its OWN crawl, so it imports
 * `@geo/core` directly and runs the deterministic checks with ZERO network I/O.
 *
 * The ONLY I/O seam in @geo/core is the injected `Fetcher` (D-05). Here we inject a
 * `fakeFetcher` that returns a canned robots.txt — proving the import is pure and
 * network-free. HOW would inject a Fetcher that returns the robots.txt it already
 * fetched during its crawl (or a real fetch impl from @geo/fetch).
 *
 * Run: `bun examples/how-inline-usage.ts`
 *
 * NOTE (cross-repo, rule 20): the actual HOW package.json dependency wiring on
 * `@geo/core` (file:/workspace/npm) is a DEFERRED cross-repo follow-up — see
 * docs/consumers.md. It is NOT performed in this repo.
 */

import {
  checkRobots,
  detectRendering,
  type Fetcher,
  type FetchResult,
  type RobotsResult,
  type RenderingResult,
} from "@geo/core";

/** Canned robots.txt: blocks GPTBot, allows everything else by default. */
const CANNED_ROBOTS_TXT = [
  "User-agent: GPTBot",
  "Disallow: /",
  "",
  "User-agent: *",
  "Disallow:",
  "",
  "Sitemap: https://example.com/sitemap.xml",
].join("\n");

/**
 * Fake Fetcher (the @geo/core injection seam). Returns the canned robots.txt for
 * ANY url with NO real network call — this is what makes the example offline.
 */
const fakeFetcher: Fetcher = async (url: string): Promise<FetchResult> => ({
  url,
  status: 200,
  headers: { "content-type": "text/plain" },
  body: CANNED_ROBOTS_TXT,
  redirectChain: [],
});

export interface InlineGeoResult {
  robots: RobotsResult;
  rendering: RenderingResult;
}

/**
 * Run the inline @geo/core checks a consumer would run with data it already holds.
 *
 * @param siteUrl - the site whose robots.txt to evaluate (passed to checkRobots)
 * @param html    - raw HTML the consumer already has (passed to detectRendering)
 * @returns structured robots + rendering results — NO network performed
 */
export async function inlineGeoChecks(
  siteUrl: string,
  html: string,
): Promise<InlineGeoResult> {
  const robots = await checkRobots(siteUrl, fakeFetcher);
  const rendering = detectRendering(html);
  return { robots, rendering };
}

// A static SSR-ish HTML string (text-rich, single script) the consumer already crawled.
const SAMPLE_HTML = `<!doctype html>
<html><head><title>Example</title></head>
<body>
  <main>
    <h1>Generative Engine Optimization</h1>
    <p>${"This page has plenty of server-rendered prose so the rendering heuristic classifies it as SSR. ".repeat(
      8,
    )}</p>
  </main>
  <script src="/analytics.js"></script>
</body></html>`;

// Runnable entrypoint: `bun examples/how-inline-usage.ts`
if (import.meta.main) {
  inlineGeoChecks("https://example.com", SAMPLE_HTML)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
