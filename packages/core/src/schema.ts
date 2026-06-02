/**
 * @geo/core — schema templates + structured-data validator (CORE-03)
 *
 * Zero dependencies. No network I/O. No throws for expected failures (D-06).
 * Prototype-pollution safe: never spread parsed JSON-LD into shared objects.
 * ReDoS guard: input length capped at MAX_HTML_BYTES before regex pass (T-01-S1).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum HTML input size before early-return (ReDoS guard, T-01-S1). */
export const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export type SchemaType =
  | "Organization"
  | "WebSite"
  | "Article"
  | "Product"
  | "BreadcrumbList"
  | "FAQPage";

export const SCHEMA_TYPES: readonly SchemaType[] = [
  "Organization",
  "WebSite",
  "Article",
  "Product",
  "BreadcrumbList",
  "FAQPage",
] as const;

// ---------------------------------------------------------------------------
// Template definitions (seeded from schema/*.json — D-09)
// ---------------------------------------------------------------------------

/** Required fields per schema type used by validateStructuredData. */
const REQUIRED_FIELDS: Record<SchemaType, string[]> = {
  Organization: ["name", "url"],
  WebSite: ["name", "url"],
  Article: ["headline", "datePublished", "author"],
  Product: ["name", "offers"],
  BreadcrumbList: ["itemListElement"],
  FAQPage: ["mainEntity"],
};

function makeOrganizationTemplate(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://YOURDOMAIN.com/#organization",
    name: "YOUR_ORGANIZATION_NAME",
    url: "https://YOURDOMAIN.com",
    logo: {
      "@type": "ImageObject",
      url: "https://YOURDOMAIN.com/logo.png",
      width: 600,
      height: 60,
    },
    description: "YOUR_ORGANIZATION_DESCRIPTION",
    foundingDate: "YYYY-MM-DD",
    contactPoint: {
      "@type": "ContactPoint",
      telephone: "+1-XXX-XXX-XXXX",
      contactType: "customer service",
      email: "contact@YOURDOMAIN.com",
      availableLanguage: ["English"],
    },
    sameAs: [
      "https://www.linkedin.com/company/YOUR_LINKEDIN",
      "https://twitter.com/YOUR_TWITTER",
    ],
  };
}

function makeWebSiteTemplate(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": "https://YOURDOMAIN.com/#website",
    name: "YOUR_SITE_NAME",
    url: "https://YOURDOMAIN.com",
    description: "YOUR_SITE_DESCRIPTION",
    publisher: {
      "@type": "Organization",
      "@id": "https://YOURDOMAIN.com/#organization",
    },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: "https://YOURDOMAIN.com/search?q={search_term_string}",
      },
      "query-input": "required name=search_term_string",
    },
    inLanguage: "en-US",
  };
}

function makeArticleTemplate(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": "https://YOURDOMAIN.com/blog/ARTICLE_SLUG/#article",
    headline: "ARTICLE_TITLE",
    description: "ARTICLE_DESCRIPTION",
    url: "https://YOURDOMAIN.com/blog/ARTICLE_SLUG",
    datePublished: "YYYY-MM-DD",
    dateModified: "YYYY-MM-DD",
    image: {
      "@type": "ImageObject",
      url: "https://YOURDOMAIN.com/images/ARTICLE_IMAGE.jpg",
      width: 1200,
      height: 630,
    },
    author: {
      "@type": "Person",
      name: "AUTHOR_NAME",
      url: "https://YOURDOMAIN.com/about/AUTHOR_SLUG",
    },
    publisher: {
      "@type": "Organization",
      "@id": "https://YOURDOMAIN.com/#organization",
      name: "YOUR_ORGANIZATION_NAME",
    },
    inLanguage: "en-US",
  };
}

function makeProductTemplate(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": "https://YOURDOMAIN.com/products/PRODUCT_SLUG/#product",
    name: "PRODUCT_NAME",
    url: "https://YOURDOMAIN.com/products/PRODUCT_SLUG",
    description: "PRODUCT_DESCRIPTION",
    image: ["https://YOURDOMAIN.com/images/products/PRODUCT_1.jpg"],
    brand: {
      "@type": "Brand",
      name: "YOUR_BRAND_NAME",
    },
    sku: "YOUR_SKU",
    offers: {
      "@type": "Offer",
      url: "https://YOURDOMAIN.com/products/PRODUCT_SLUG",
      price: "XX.XX",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: "4.6",
      reviewCount: "XXX",
    },
  };
}

function makeBreadcrumbListTemplate(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://YOURDOMAIN.com",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Category",
        item: "https://YOURDOMAIN.com/category",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "Page Title",
        item: "https://YOURDOMAIN.com/category/page",
      },
    ],
  };
}

function makeFAQPageTemplate(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "QUESTION_TEXT",
        acceptedAnswer: {
          "@type": "Answer",
          text: "ANSWER_TEXT",
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Public: getSchemaTemplates
// ---------------------------------------------------------------------------

/**
 * Returns a typed schema.org JSON-LD template object for the given type.
 * Seeded from repo schema/*.json files (D-09).
 * Throws only for unknown type literal (programmer error, D-06).
 */
export function getSchemaTemplates(type: SchemaType): Record<string, unknown> {
  switch (type) {
    case "Organization":
      return makeOrganizationTemplate();
    case "WebSite":
      return makeWebSiteTemplate();
    case "Article":
      return makeArticleTemplate();
    case "Product":
      return makeProductTemplate();
    case "BreadcrumbList":
      return makeBreadcrumbListTemplate();
    case "FAQPage":
      return makeFAQPageTemplate();
    default: {
      // Exhaustiveness check — TypeScript will warn if a case is missing.
      const _exhaustive: never = type;
      throw new Error(`Unknown schema type: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: JSON-LD extraction (Pattern-4, Pitfall-3 — extract before strip)
// ---------------------------------------------------------------------------

/** Regex matches <script type="application/ld+json"> ... </script> (case-insensitive, lazy). */
const JSON_LD_SCRIPT_RE =
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

interface ParsedBlock {
  raw: string;
  /** Flattened objects from this script block (may be >1 for @graph / top-level arrays). */
  objects: Array<Record<string, unknown>>;
  error?: string;
  /** True if this block was successfully parsed (regardless of how many objects it contained). */
  valid: boolean;
}

/**
 * Extract and parse all JSON-LD script blocks from raw HTML.
 * Run BEFORE any HTML stripping (Pitfall-3).
 * Safe against ReDoS via input-length guard (T-01-S1).
 * Prototype-pollution safe: never merges parsed objects (T-01-S2).
 */
function extractJsonLdBlocks(html: string): { blocks: ParsedBlock[]; errors: string[] } {
  const errors: string[] = [];
  const blocks: ParsedBlock[] = [];

  if (html.length > MAX_HTML_BYTES) {
    errors.push(`HTML input exceeds maximum size (${MAX_HTML_BYTES} bytes); structured data extraction skipped.`);
    return { blocks, errors };
  }

  let match: RegExpExecArray | null;
  // Reset lastIndex — the regex is defined at module scope with /g flag.
  JSON_LD_SCRIPT_RE.lastIndex = 0;

  while ((match = JSON_LD_SCRIPT_RE.exec(html)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as unknown;
      // Handle top-level arrays and @graph — normalize to flat list of objects.
      const objects = flattenJsonLd(parsed);
      blocks.push({ raw, objects, valid: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to parse JSON-LD block: ${msg}`);
      blocks.push({ raw, objects: [], valid: false, error: msg });
    }
  }

  return { blocks, errors };
}

/**
 * Normalize a parsed JSON-LD value into a flat array of plain objects.
 * Handles: single object, array of objects, `@graph` wrapper.
 * Prototype-pollution safe: reads only own properties via Object.hasOwn.
 */
function flattenJsonLd(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    const out: Array<Record<string, unknown>> = [];
    for (const item of value) {
      out.push(...flattenJsonLd(item));
    }
    return out;
  }

  const obj = value as Record<string, unknown>;

  // @graph wrapper
  if (Object.hasOwn(obj, "@graph") && Array.isArray(obj["@graph"])) {
    return flattenJsonLd(obj["@graph"]);
  }

  return [obj];
}

/**
 * Safely read the @type field from a parsed JSON-LD object.
 * Returns an array of type strings (handles string or string[]).
 * Never reads inherited properties.
 */
function getTypes(obj: Record<string, unknown>): string[] {
  if (!Object.hasOwn(obj, "@type")) return [];
  const raw = obj["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  return [];
}

// ---------------------------------------------------------------------------
// Public: validateStructuredData
// ---------------------------------------------------------------------------

export interface StructuredDataEntry {
  type: string;
  valid: boolean;
  missingFields: string[];
}

export interface StructuredDataValidationResult {
  found: StructuredDataEntry[];
  jsonLdCount: number;
  errors: string[];
}

/**
 * Extract JSON-LD from raw HTML and report presence/validity per schema type.
 * - Does not throw on malformed JSON-LD (T-01-S3).
 * - Prototype-pollution safe (T-01-S2).
 * - Input-length guarded (T-01-S1).
 */
export function validateStructuredData(html: string): StructuredDataValidationResult {
  const { blocks, errors } = extractJsonLdBlocks(html);

  const found: StructuredDataEntry[] = [];
  let jsonLdCount = 0;

  for (const block of blocks) {
    if (!block.valid) {
      // Malformed — counted in errors, not in found or jsonLdCount.
      continue;
    }

    jsonLdCount++;

    for (const obj of block.objects) {
      const types = getTypes(obj);

      if (types.length === 0) {
        // No @type — record as unknown.
        found.push({ type: "Unknown", valid: false, missingFields: ["@type"] });
        continue;
      }

      for (const type of types) {
        const requiredFields = REQUIRED_FIELDS[type as SchemaType] ?? [];
        const missingFields = requiredFields.filter(
          (field) => !Object.hasOwn(obj, field) || obj[field] == null
        );
        found.push({
          type,
          valid: missingFields.length === 0,
          missingFields,
        });
      }
    }
  }

  return { found, jsonLdCount, errors };
}
