/**
 * checkRobots — fetch and parse robots.txt, returning per-AI-crawler status.
 *
 * Design constraints (D-05, D-06):
 *   - Zero network I/O: caller supplies a Fetcher.
 *   - Never throws for expected failure states (missing robots.txt, bad URL, non-2xx).
 *   - Sitemap URLs validated via `new URL()` — never string-concatenated (Pitfall-4 fix).
 *   - Line-by-line parser; no full-body regex (T-01-R1 DoS guard).
 *   - CRLF-tolerant (strip \r before processing).
 */

import type { Fetcher, RobotsResult, AiCrawler, CrawlerStatus } from "./types.js";
import { AI_CRAWLERS } from "./types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type RuleDirective = "Allow" | "Disallow";

interface Rule {
  directive: RuleDirective;
  path: string;
}

type AgentRules = Map<string, Rule[]>;

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

/**
 * Parse robots.txt body into per-agent rule groups.
 * Handles:
 *   - Multiple User-agent lines before a rule block (group them together).
 *   - Blank-line group termination (RFC 9309 §2.1).
 *   - Case-insensitive directives.
 *   - CRLF line endings.
 *   - Comments (# …).
 *   - Empty Disallow: (= allow all, represented as path "").
 */
function parseRobotsTxt(body: string): { agentRules: AgentRules; sitemaps: string[] } {
  const agentRules: AgentRules = new Map();
  const sitemaps: string[] = [];

  // Current group of user-agents being accumulated before any rules appear.
  let pendingAgents: string[] = [];
  // Whether the current group has received at least one rule line.
  let groupHasRules = false;

  const lines = body.split("\n");

  for (const rawLine of lines) {
    // Normalise CRLF and strip inline comments.
    const line = rawLine.replace(/\r$/, "").replace(/#.*$/, "").trim();

    if (line === "") {
      // Blank line terminates the current group.
      pendingAgents = [];
      groupHasRules = false;
      continue;
    }

    const lower = line.toLowerCase();

    if (lower.startsWith("user-agent:")) {
      const agent = line.slice("user-agent:".length).trim();
      if (!agent) continue;

      if (groupHasRules) {
        // A new User-agent line after rules started = new group.
        pendingAgents = [agent];
        groupHasRules = false;
      } else {
        // Accumulate multiple User-agent lines for the same group.
        pendingAgents.push(agent);
      }
      // Ensure entry exists for each agent.
      for (const a of pendingAgents) {
        if (!agentRules.has(a)) agentRules.set(a, []);
      }
      continue;
    }

    if (lower.startsWith("disallow:") && pendingAgents.length > 0) {
      const path = line.slice("disallow:".length).trim();
      groupHasRules = true;
      for (const a of pendingAgents) {
        const rules = agentRules.get(a) ?? [];
        rules.push({ directive: "Disallow", path });
        agentRules.set(a, rules);
      }
      continue;
    }

    if (lower.startsWith("allow:") && pendingAgents.length > 0) {
      const path = line.slice("allow:".length).trim();
      groupHasRules = true;
      for (const a of pendingAgents) {
        const rules = agentRules.get(a) ?? [];
        rules.push({ directive: "Allow", path });
        agentRules.set(a, rules);
      }
      continue;
    }

    if (lower.startsWith("sitemap:")) {
      const raw = line.slice("sitemap:".length).trim();
      // Pitfall-4 fix: validate via new URL(); never concat scheme strings.
      try {
        const parsed = new URL(raw);
        // Only accept absolute http/https URLs.
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          sitemaps.push(parsed.href);
        }
      } catch {
        // Invalid URL — skip silently (logged at call site if needed).
      }
      continue;
    }
  }

  return { agentRules, sitemaps };
}

/**
 * Determine the crawlability status for a single AI crawler agent.
 */
function resolveStatus(crawler: AiCrawler, agentRules: AgentRules): CrawlerStatus {
  // Check for a specific rule for this crawler (case-insensitive key match).
  const exactKey = [...agentRules.keys()].find(
    (k) => k.toLowerCase() === crawler.toLowerCase()
  );

  if (exactKey !== undefined) {
    const rules = agentRules.get(exactKey) ?? [];
    if (rules.length === 0) return "ALLOWED";

    // Empty Disallow: means allow all.
    const hasEmptyDisallow = rules.some(
      (r) => r.directive === "Disallow" && r.path === ""
    );
    if (hasEmptyDisallow && !rules.some((r) => r.directive === "Disallow" && r.path !== "")) {
      return "ALLOWED";
    }

    const blockedAll = rules.some((r) => r.directive === "Disallow" && r.path === "/");
    if (blockedAll) return "BLOCKED";

    const hasDisallow = rules.some((r) => r.directive === "Disallow" && r.path !== "");
    if (hasDisallow) return "PARTIALLY_BLOCKED";

    return "ALLOWED";
  }

  // Fall back to wildcard (*) group.
  const wildcardRules = agentRules.get("*") ?? [];
  if (wildcardRules.length === 0 && !agentRules.has("*")) {
    return "NOT_MENTIONED";
  }

  const wildcardBlocksAll = wildcardRules.some(
    (r) => r.directive === "Disallow" && r.path === "/"
  );
  if (wildcardBlocksAll) return "BLOCKED_BY_WILDCARD";

  return "ALLOWED_BY_DEFAULT";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch and parse robots.txt for the given site, returning AI-crawler
 * crawlability status and sitemap URLs.
 *
 * Never throws. Returns a structured result with `errors` populated on
 * unexpected failure. Missing robots.txt (404) is not an error (D-06).
 */
export async function checkRobots(
  siteUrl: string,
  fetcher: Fetcher
): Promise<RobotsResult> {
  // V5: validate siteUrl before any fetch.
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", siteUrl).href;
  } catch {
    const empty = Object.fromEntries(
      AI_CRAWLERS.map((c) => [c, "NO_ROBOTS_TXT" as CrawlerStatus])
    ) as Record<AiCrawler, CrawlerStatus>;
    return {
      url: siteUrl,
      exists: false,
      content: "",
      aiCrawlerStatus: empty,
      sitemaps: [],
      errors: [`Invalid siteUrl: ${siteUrl}`],
    };
  }

  let fetchResult;
  try {
    fetchResult = await fetcher(robotsUrl);
  } catch (err) {
    const empty = Object.fromEntries(
      AI_CRAWLERS.map((c) => [c, "NO_ROBOTS_TXT" as CrawlerStatus])
    ) as Record<AiCrawler, CrawlerStatus>;
    return {
      url: robotsUrl,
      exists: false,
      content: "",
      aiCrawlerStatus: empty,
      sitemaps: [],
      errors: [`Fetcher error: ${String(err)}`],
    };
  }

  // 404 or other non-2xx: not an error per D-06, just absent.
  if (fetchResult.status === 404 || fetchResult.status < 200 || fetchResult.status >= 300) {
    const noRobots = Object.fromEntries(
      AI_CRAWLERS.map((c) => [c, "NO_ROBOTS_TXT" as CrawlerStatus])
    ) as Record<AiCrawler, CrawlerStatus>;
    return {
      url: robotsUrl,
      exists: false,
      content: "",
      aiCrawlerStatus: noRobots,
      sitemaps: [],
      errors: [],
    };
  }

  // Successful fetch — parse.
  const { agentRules, sitemaps } = parseRobotsTxt(fetchResult.body);

  const aiCrawlerStatus = Object.fromEntries(
    AI_CRAWLERS.map((c) => [c, resolveStatus(c, agentRules)])
  ) as Record<AiCrawler, CrawlerStatus>;

  return {
    url: robotsUrl,
    exists: true,
    content: fetchResult.body,
    aiCrawlerStatus,
    sitemaps,
    errors: [],
  };
}
