/**
 * @geo/core — llms.txt generator and validator (CORE-02)
 *
 * generateLlmsTxt: produces a spec-shaped llms.txt string from structured crawl data.
 * validateLlmsTxt: checks a text string for mandatory (title) and recommended elements.
 *
 * Zero network I/O. No template libraries. Stdlib string building only.
 * Deterministic: same input → byte-identical output.
 *
 * llmstxt.org convention:
 *   # Title          (required)
 *   > description    (recommended)
 *   ## Section       (recommended)
 *   - [Title](url): desc  (recommended)
 */

import type { LlmsTxtResult } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CrawlPage {
  title: string;
  url: string;
  description?: string;
  /** Omit for default "Pages" section. */
  section?: string;
}

export interface CrawlData {
  /** Site display name → becomes # Title line. */
  siteName: string;
  siteUrl: string;
  description?: string;
  pages: CrawlPage[];
  contact?: {
    website?: string;
    email?: string;
  };
}

/** Extended result returned by validateLlmsTxt. */
export interface LlmsTxtValidationResult extends LlmsTxtResult {
  valid: boolean;
  hasTitle: boolean;
  hasDescription: boolean;
  sectionCount: number;
  linkCount: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_SECTION = "Pages";

/**
 * Escape characters that would corrupt a Markdown link title:
 *   [ → \[
 *   ] → \]
 * Parentheses in link text are technically safe but we escape them in
 * descriptions (which appear after `: `) to prevent confusion.
 */
function escapeLinkTitle(s: string): string {
  return s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function escapeDescription(s: string): string {
  // Descriptions appear after `: ` — guard against newlines embedding stray lines
  return s.replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// generateLlmsTxt
// ---------------------------------------------------------------------------

/**
 * Generate a valid llms.txt document from structured crawl data.
 *
 * Section order: first-seen section order is preserved, then page order
 * within each section. Pages with no section fall under DEFAULT_SECTION.
 */
export function generateLlmsTxt(crawlData: CrawlData): string {
  const lines: string[] = [];

  // # Title (required)
  lines.push(`# ${escapeLinkTitle(crawlData.siteName)}`);
  lines.push("");

  // > description (recommended)
  if (crawlData.description) {
    lines.push(`> ${escapeDescription(crawlData.description)}`);
    lines.push("");
  }

  // Group pages preserving first-seen section order
  const sectionOrder: string[] = [];
  const sectionMap = new Map<string, CrawlPage[]>();

  for (const page of crawlData.pages) {
    const sec = page.section ?? DEFAULT_SECTION;
    if (!sectionMap.has(sec)) {
      sectionOrder.push(sec);
      sectionMap.set(sec, []);
    }
    sectionMap.get(sec)!.push(page);
  }

  for (const sec of sectionOrder) {
    lines.push(`## ${sec}`);
    lines.push("");
    for (const page of sectionMap.get(sec)!) {
      const titlePart = `[${escapeLinkTitle(page.title)}](${page.url})`;
      if (page.description) {
        lines.push(`- ${titlePart}: ${escapeDescription(page.description)}`);
      } else {
        lines.push(`- ${titlePart}`);
      }
    }
    lines.push("");
  }

  // ## Contact section (optional)
  if (crawlData.contact) {
    const { website, email } = crawlData.contact;
    if (website || email) {
      lines.push("## Contact");
      lines.push("");
      if (website) lines.push(`- Website: ${website}`);
      if (email) lines.push(`- Email: ${email}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// validateLlmsTxt
// ---------------------------------------------------------------------------

// T-01-L1 mitigation: line-split scanning only; no backtracking-prone regex on whole doc.
// Link detection: simple startsWith("- [") + contains("](") check, bounded per line.
const LINK_SIMPLE_RE = /^- \[.+\]\(.+\)/;

/**
 * Validate a raw llms.txt string.
 *
 * Returns:
 *   valid        — true iff # Title line is present (A4: only title is mandatory)
 *   errors[]     — mandatory violations (missing title only)
 *   warnings[]   — recommended element absences (description, sections, links)
 */
export function validateLlmsTxt(text: string): LlmsTxtValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!text || !text.trim()) {
    errors.push("Missing title: document is empty (expected '# Site Name' on first non-blank line)");
    return {
      valid: false,
      hasTitle: false,
      hasDescription: false,
      sectionCount: 0,
      linkCount: 0,
      errors,
      warnings,
      content: text,
      sections: [],
    };
  }

  const lines = text.split("\n");

  // --- hasTitle: first non-blank line must be `# ` ---
  let hasTitle = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    hasTitle = line.startsWith("# ");
    break;
  }

  if (!hasTitle) {
    errors.push("Missing title: expected '# Site Name' as the first content line");
  }

  // --- hasDescription ---
  let hasDescription = false;
  for (const line of lines) {
    if (line.startsWith("> ")) {
      hasDescription = true;
      break;
    }
  }
  if (!hasDescription) {
    warnings.push("Missing description: recommend adding '> Brief description of the site'");
  }

  // --- sections ---
  const sectionLines = lines.filter((l) => l.startsWith("## "));
  const sectionCount = sectionLines.length;
  if (sectionCount === 0) {
    warnings.push("No sections found: recommend adding '## Section Name' headings");
  }

  // --- links (T-01-L1: per-line test, no full-doc backtracking) ---
  let linkCount = 0;
  for (const line of lines) {
    if (LINK_SIMPLE_RE.test(line)) linkCount++;
  }
  if (linkCount === 0) {
    warnings.push("No links found: recommend adding '- [Page Title](url): Description' entries");
  }

  // Reconstruct sections for LlmsTxtResult.sections field
  const sections: LlmsTxtResult["sections"] = [];
  let currentSection: { title: string; items: Array<{ title: string; url: string; description?: string }> } | null = null;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      currentSection = { title: line.slice(3).trim(), items: [] };
      sections.push(currentSection);
    } else if (currentSection && LINK_SIMPLE_RE.test(line)) {
      // Parse `- [Title](url): desc` or `- [Title](url)`
      const match = line.match(/^- \[([^\]]*)\]\(([^)]*)\)(?:: (.+))?$/);
      if (match) {
        currentSection.items.push({
          title: match[1] ?? "",
          url: match[2] ?? "",
          description: match[3],
        });
      }
    }
  }

  return {
    valid: hasTitle,
    hasTitle,
    hasDescription,
    sectionCount,
    linkCount,
    errors,
    warnings,
    content: text,
    sections,
  };
}
