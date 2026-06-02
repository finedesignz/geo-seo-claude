/**
 * CORE-01: checkRobots — vitest unit tests with mocked Fetcher (no network).
 */

import { describe, it, expect } from "vitest";
import { checkRobots } from "../robots.js";
import type { FetchResult } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFetcher(overrides: Partial<FetchResult> = {}) {
  return async (_url: string): Promise<FetchResult> => ({
    url: _url,
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "",
    redirectChain: [],
    ...overrides,
  });
}

function robotsFetcher(body: string) {
  return makeFetcher({ body });
}

// ---------------------------------------------------------------------------
// Basic crawlability
// ---------------------------------------------------------------------------

describe("checkRobots — explicit agent rules", () => {
  it("GPTBot disallowed / = BLOCKED", async () => {
    const body = `User-agent: GPTBot\nDisallow: /\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.aiCrawlerStatus.GPTBot).toBe("BLOCKED");
    expect(result.exists).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("ClaudeBot partially disallowed = PARTIALLY_BLOCKED", async () => {
    const body = `User-agent: ClaudeBot\nDisallow: /private/\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.aiCrawlerStatus.ClaudeBot).toBe("PARTIALLY_BLOCKED");
  });

  it("PerplexityBot explicitly allowed = ALLOWED", async () => {
    const body = `User-agent: PerplexityBot\nAllow: /\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.aiCrawlerStatus.PerplexityBot).toBe("ALLOWED");
  });

  it("crawler not mentioned and no wildcard = NOT_MENTIONED", async () => {
    const body = `User-agent: GPTBot\nDisallow: /\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    // BingBot is in AI_CRAWLERS but not in this robots.txt, no wildcard.
    expect(result.aiCrawlerStatus.BingBot).toBe("NOT_MENTIONED");
  });
});

// ---------------------------------------------------------------------------
// Wildcard fallback
// ---------------------------------------------------------------------------

describe("checkRobots — wildcard rules", () => {
  it("wildcard Disallow: / → unmentioned crawlers = BLOCKED_BY_WILDCARD", async () => {
    const body = `User-agent: *\nDisallow: /\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    // No specific rule for BingBot, but wildcard blocks everything.
    expect(result.aiCrawlerStatus.BingBot).toBe("BLOCKED_BY_WILDCARD");
  });

  it("wildcard partial disallow → unmentioned crawlers = ALLOWED_BY_DEFAULT", async () => {
    const body = `User-agent: *\nDisallow: /admin/\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.aiCrawlerStatus.BingBot).toBe("ALLOWED_BY_DEFAULT");
  });

  it("GPTBot blocked, BingBot falls to wildcard BLOCKED_BY_WILDCARD", async () => {
    const body = `User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.aiCrawlerStatus.GPTBot).toBe("BLOCKED");
    expect(result.aiCrawlerStatus.BingBot).toBe("BLOCKED_BY_WILDCARD");
  });
});

// ---------------------------------------------------------------------------
// 404 / missing robots.txt
// ---------------------------------------------------------------------------

describe("checkRobots — missing robots.txt", () => {
  it("fetcher returns 404 → exists:false, all crawlers NO_ROBOTS_TXT, errors empty", async () => {
    const fetcher = makeFetcher({ status: 404, body: "Not Found" });
    const result = await checkRobots("https://example.com", fetcher);
    expect(result.exists).toBe(false);
    expect(result.errors).toHaveLength(0);
    for (const status of Object.values(result.aiCrawlerStatus)) {
      expect(status).toBe("NO_ROBOTS_TXT");
    }
  });

  it("fetcher returns 403 → treated as missing (no error)", async () => {
    const fetcher = makeFetcher({ status: 403, body: "Forbidden" });
    const result = await checkRobots("https://example.com", fetcher);
    expect(result.exists).toBe(false);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sitemap parsing — Pitfall-4 bug fix
// ---------------------------------------------------------------------------

describe("checkRobots — sitemap parsing", () => {
  it("extracts https:// sitemaps correctly (no httphttps corruption)", async () => {
    const body = `User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.sitemaps).toContain("https://example.com/sitemap.xml");
    // Bug-fix assertion: must never start with httphttps.
    for (const s of result.sitemaps) {
      expect(s.startsWith("httphttps")).toBe(false);
    }
  });

  it("extracts multiple sitemaps", async () => {
    const body = [
      "User-agent: *",
      "Allow: /",
      "",
      "Sitemap: https://example.com/sitemap.xml",
      "Sitemap: https://example.com/sitemap-news.xml",
    ].join("\n");
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.sitemaps).toHaveLength(2);
    expect(result.sitemaps[0]).toBe("https://example.com/sitemap.xml");
    expect(result.sitemaps[1]).toBe("https://example.com/sitemap-news.xml");
  });

  it("rejects invalid sitemap URLs silently", async () => {
    const body = `Sitemap: not-a-url\nSitemap: https://good.com/sitemap.xml\n`;
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.sitemaps).toHaveLength(1);
    expect(result.sitemaps[0]).toBe("https://good.com/sitemap.xml");
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("checkRobots — invalid siteUrl", () => {
  it("returns structured result with errors and no throw for garbage input", async () => {
    // This fetcher should never be called for invalid URLs.
    const fetcher = makeFetcher();
    const result = await checkRobots("garbage", fetcher);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("checkRobots — edge cases", () => {
  it("CRLF line endings parsed correctly", async () => {
    const body = "User-agent: GPTBot\r\nDisallow: /\r\n";
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.aiCrawlerStatus.GPTBot).toBe("BLOCKED");
  });

  it("case-insensitive directives", async () => {
    const body = "USER-AGENT: GPTBot\nDISALLOW: /\n";
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.aiCrawlerStatus.GPTBot).toBe("BLOCKED");
  });

  it("empty Disallow: = allow all", async () => {
    const body = "User-agent: GPTBot\nDisallow:\n";
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    expect(result.aiCrawlerStatus.GPTBot).toBe("ALLOWED");
  });

  it("inline comments stripped", async () => {
    const body = "User-agent: GPTBot # this is a comment\nDisallow: /\n";
    const result = await checkRobots("https://example.com", robotsFetcher(body));
    // Agent name will include the comment if not stripped, failing to match GPTBot.
    // With comment stripping, it should match and be BLOCKED.
    expect(result.aiCrawlerStatus.GPTBot).toBe("BLOCKED");
  });

  it("robots.txt URL is constructed correctly", async () => {
    const seenUrls: string[] = [];
    const fetcher = async (url: string): Promise<FetchResult> => {
      seenUrls.push(url);
      return { url, status: 404, headers: {}, body: "", redirectChain: [] };
    };
    await checkRobots("https://example.com/some/path", fetcher);
    expect(seenUrls[0]).toBe("https://example.com/robots.txt");
  });
});
