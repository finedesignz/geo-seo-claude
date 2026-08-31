# Phase 1: @geo/core — Deterministic Package - Research

**Researched:** 2026-06-02
**Domain:** Zero-dependency TypeScript package — HTML parsing, robots.txt, llms.txt, schema.org, citability heuristics, SSR/CSR detection
**Confidence:** HIGH (standard stack verified on npm; heuristics ported from in-repo Python source)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `packages/core/` in this repo, Bun workspaces root `package.json` array.
- **D-02:** ESM-first dual output (ESM + CJS + `.d.ts`) via `tsup`. `"type": "module"`.
- **D-03:** `strict: true`, `noUncheckedIndexedAccess`. Node/Bun ≥ current LTS.
- **D-04:** Zero *runtime* deps. DOM-free string/regex parsing — NO cheerio/jsdom at runtime.
- **D-05:** Fetch is injected. Every network function accepts `fetcher: (url: string) => Promise<FetchResult>`. Package ships `FetchResult`/`Fetcher` types only.
- **D-06:** Pure functions, typed JSON-serializable result objects. No throw for expected failure states. Throw only for programmer error.
- **D-07:** Citability = weighted composite with exported `CITABILITY_WEIGHTS` constant. Output: 0–100 + per-signal breakdown.
- **D-08:** SSR/CSR = heuristic over initial HTML (text/content ratio, script-bundle weight, framework hydration markers). Returns `{ rendering, confidence, signals[] }`.
- **D-09:** Schema.org templates for Organization, WebSite, Article, Product, BreadcrumbList, FAQPage + JSON-LD/microdata validator.
- **D-10:** llms.txt generated from crawl data per llmstxt.org convention.
- **D-11:** Logic ported from Python, not wrapped. Re-derive thresholds in TS, cover with tests.
- **D-12:** Vitest unit tests, fixture HTML, no network. Mock fetcher.

### Claude's Discretion
None listed — all decisions locked.

### Deferred Ideas (OUT OF SCOPE)
- Hardened SSRF fetcher → Phase 2
- Scoring LLM call → Phase 4
- Publishing to npm registry → not needed (internal 2-consumer model)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CORE-01 | `checkRobots(url, fetcher)` — robots.txt fetch + parse; AI-bot crawlability per agent | Python `fetch_robots_txt` logic fully documented in source; AI crawler list extracted; known bugs documented for fix in port |
| CORE-02 | `generateLlmsTxt(crawlData)` — generate llms.txt from crawl data | llmstxt.org spec confirmed; Python `generate_llmstxt` logic as port base; format: `# Title`, `> Description`, `## Section`, `- [Title](url): desc` |
| CORE-03 | `getSchemaTemplates(pageData)` + validator — schema.org templates + JSON-LD/microdata extraction | 6 existing JSON templates in `schema/`; JSON-LD extraction via regex `<script type="application/ld+json">` is zero-dep viable |
| CORE-04 | `computeCitabilityScore(pageData)` — deterministic 0–100 sub-scores + breakdown | Python `score_passage` / `analyze_page_citability` fully ported; 5-category weights documented and extractable as `CITABILITY_WEIGHTS` |
| CORE-05 | `detectRendering(html)` — SSR vs CSR detection from raw HTML | Python heuristic documented (root div text length + word count thresholds); known bugs documented; hydration markers list extracted |
| CORE-06 | Package consumable by both hyperoptimizedwebsites and geo-api service | Bun workspace + tsup dual output is the standard pattern; `exports` map covers both ESM and CJS consumers |
</phase_requirements>

---

## Summary

`@geo/core` is a greenfield TS package bootstrapped inside the existing Python repo. The Python source (`scripts/fetch_page.py`, `scripts/citability_scorer.py`, `scripts/llmstxt_generator.py`) provides the complete heuristic logic to port — it is well-understood and fully readable. The primary engineering challenge is not algorithmic: it is (1) setting up the Bun workspace + tsup build correctly so both consumers can import cleanly, and (2) doing zero-dep HTML parsing for JSON-LD extraction, SSR detection, and heading analysis without cheerio/jsdom.

The fetch-injection seam (D-05) is the most architecturally load-bearing decision this phase makes — it determines the `FetchResult`/`Fetcher` contract that Phase 2's hardened fetcher must satisfy. Get the types right now; Phase 2 is just a conforming implementation.

HTML parsing without runtime deps is viable for this use case: robots.txt is plaintext line-by-line, llms.txt is Markdown, JSON-LD is a `<script>` tag the content of which is pure JSON, and SSR/CSR detection requires only counting text nodes vs. framework markers in the raw HTML string. Full DOM parsing (for content blocks / citability) is the one area that benefits from a real parser — but it can be handled with well-targeted regex over `<p>`, `<h1>`–`<h6>`, `<ul>`, `<ol>` tags, which is a known-safe pattern at this scale.

**Primary recommendation:** Port heuristics faithfully from Python, fix the documented bugs during the port (especially the robots.txt sitemap URL corruption and the brittle SSR threshold), expose `CITABILITY_WEIGHTS` as a typed const, and nail the `FetchResult`/`Fetcher` seam — that contract is consumed by 4 downstream phases.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| robots.txt parsing | `@geo/core` (pure function) | — | Deterministic text parsing; no I/O |
| llms.txt generation | `@geo/core` (pure function) | — | Generates from caller-supplied crawl data |
| Schema.org templates + validator | `@geo/core` (pure function) | — | Template objects + regex extraction from HTML string |
| Citability scoring | `@geo/core` (pure function) | — | Regex + word-count heuristics over HTML string |
| SSR/CSR detection | `@geo/core` (pure function) | — | Heuristics over raw HTML string |
| Network I/O | Caller (Phase 2 fetcher) | — | Injected; `@geo/core` has no runtime network access |
| Build / package resolution | Bun workspace root | tsup | Workspace links package to consumers at dev time |

---

## Standard Stack

### Core (dev dependencies only — zero runtime deps)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `tsup` | 8.5.1 | Dual ESM+CJS build with `.d.ts` generation | esbuild-powered, zero-config for this pattern; locked in D-02 |
| `vitest` | 4.1.8 | Unit testing | Locked in D-12; first-class Bun support |
| `typescript` | 6.0.3 | Language | Locked in D-03 |
| `@types/node` | 25.9.1 | Node type stubs for TS | Required for `URL`, `URLSearchParams` etc. in strict mode |

[VERIFIED: npm registry] — all four confirmed via `npm view` at research time. Source repos: egoist/tsup, vitest-dev/vitest, microsoft/TypeScript.

### Supporting (also dev-only)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@vitest/coverage-v8` | latest | Coverage reports | Optional; useful for per-signal citability branch coverage |

### No Runtime Dependencies
Zero runtime dependencies is a hard constraint (D-04). The standard library (`URL`, `URLSearchParams`, regex, `JSON.parse`) covers every need in this package.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled regex HTML parsing | `node-html-parser` (runtime dep) | Simpler API but violates D-04 |
| Hand-rolled regex HTML parsing | `cheerio` (runtime dep) | jQuery-like API but violates D-04 and adds ~3MB |
| tsup | `tsdown` (alternative) | Newer, less proven; tsup has 4+ years of adoption |
| tsup | `pkgroll` | Less flexible for this exact exports-map pattern |

**Installation (dev only):**
```bash
bun add -D tsup vitest typescript @types/node
```

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck (npm) | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `tsup` | npm | 6 yrs (2020-05-10) | ~5M/wk | github.com/egoist/tsup | [OK] (npm verified) | Approved |
| `vitest` | npm | 4.5 yrs (2021-12-03) | ~20M/wk | github.com/vitest-dev/vitest | [OK] (npm verified) | Approved |
| `typescript` | npm | 12+ yrs | ~60M/wk | github.com/microsoft/TypeScript | [OK] | Approved |
| `@types/node` | npm | 10+ yrs | ~50M/wk | github.com/DefinitelyTyped/DefinitelyTyped | [OK] | Approved |

**Note:** slopcheck flagged tsup as [SLOP] and vitest as [SUS] because it checked PyPI (Python registry), not npm. These are Node.js packages with no PyPI presence — the slopcheck PyPI result is a false positive from ecosystem confusion. Both packages are confirmed legitimate on npm with multi-year histories, official source repos, and tens of millions of weekly downloads. [VERIFIED: npm registry]

**Packages removed due to slopcheck [SLOP] verdict:** none (false positive from wrong ecosystem)
**Packages flagged as suspicious [SUS]:** none (false positive from wrong ecosystem)

---

## Architecture Patterns

### System Architecture Diagram

```
Consumer (HOW or geo-api service)
      │
      │  provides: FetchResult (HTML, headers, status, url)
      │  provides: CrawlData (pages[], site metadata)
      ▼
┌─────────────────────────────────────────────────────┐
│                   @geo/core                          │
│                                                      │
│  checkRobots(robotsTxt: string, url: string)         │
│    └─ parse text → AI crawler rules → RobotsResult   │
│                                                      │
│  generateLlmsTxt(crawlData: CrawlData)               │
│    └─ categorize pages → format Markdown → string    │
│                                                      │
│  getSchemaTemplates(type)                            │
│    └─ return typed template object                   │
│                                                      │
│  validateStructuredData(html: string)                │
│    └─ regex extract <script ld+json> → parse JSON    │
│       → check required fields → ValidationResult     │
│                                                      │
│  computeCitabilityScore(pageData: PageData)          │
│    └─ extract blocks from HTML string                │
│       → score each (5 categories × weights)         │
│       → aggregate → CitabilityResult                 │
│                                                      │
│  detectRendering(html: string)                       │
│    └─ check hydration markers, text/script ratio     │
│       → RenderingResult { rendering, confidence }    │
│                                                      │
│  export CITABILITY_WEIGHTS (const)                   │
└─────────────────────────────────────────────────────┘
      │
      ▼
  JSON-serializable result objects
  (consumed by Phase 4 scoring prompt + Phase 5 API)
```

### Recommended Project Structure

```
packages/core/
├── package.json          # name: @geo/core, "type": "module", exports map
├── tsconfig.json         # strict: true, noUncheckedIndexedAccess
├── tsup.config.ts        # format: ["esm","cjs"], dts: true
├── src/
│   ├── index.ts          # barrel: re-export all public API + types
│   ├── types.ts          # FetchResult, Fetcher, PageData, CrawlData, all result types
│   ├── robots.ts         # checkRobots()
│   ├── llmstxt.ts        # generateLlmsTxt(), validateLlmsTxt()
│   ├── schema.ts         # getSchemaTemplates(), validateStructuredData()
│   ├── citability.ts     # computeCitabilityScore(), score_passage(), CITABILITY_WEIGHTS
│   └── rendering.ts      # detectRendering()
├── fixtures/             # test fixture HTML files
│   ├── ssr-page.html
│   ├── csr-page.html
│   ├── schema-rich.html
│   ├── schema-none.html
│   └── llmstxt-valid.txt
└── src/__tests__/
    ├── robots.test.ts
    ├── llmstxt.test.ts
    ├── schema.test.ts
    ├── citability.test.ts
    └── rendering.test.ts
```

### Pattern 1: tsup Dual ESM+CJS Build

**What:** Single source, two output formats.
**When to use:** Any TS library that must work in both Node ESM and CJS consumers.

`tsup.config.ts`:
```typescript
// Source: https://tsup.egoist.dev/
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

`package.json` exports map (D-02 pattern):
```json
{
  "name": "@geo/core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts"
}
```

**Critical:** `types` must be FIRST in each condition object for TypeScript module resolution to pick it up. [CITED: https://tsup.egoist.dev/]

### Pattern 2: Bun Workspace Root Package.json

```json
{
  "name": "geo-seo-claude",
  "workspaces": ["packages/*", "packages/core"],
  "private": true
}
```

Consumer (`geo-api` service at repo root or `src/`):
```json
{
  "dependencies": {
    "@geo/core": "workspace:*"
  }
}
```

Bun resolves `workspace:*` to the local path at install time. [CITED: https://bun.com/docs/pm/workspaces]

### Pattern 3: Fetch Injection Contract (Phase 1↔2 seam)

The most critical type contract this phase produces:

```typescript
// src/types.ts
export interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;               // raw response text (HTML, robots.txt, etc.)
  redirectChain: Array<{ url: string; status: number }>;
  error?: string;
}

export type Fetcher = (url: string) => Promise<FetchResult>;

// Every network-dependent function takes a fetcher parameter:
export async function checkRobots(
  siteUrl: string,
  fetcher: Fetcher,
): Promise<RobotsResult> { ... }
```

Phase 2 provides a hardened `Fetcher` implementation; tests mock it with fixtures.

### Pattern 4: Zero-Dep JSON-LD Extraction

```typescript
// Extract all <script type="application/ld+json"> blocks from raw HTML
function extractJsonLd(html: string): unknown[] {
  const results: unknown[] = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    try {
      results.push(JSON.parse(match[1]!));
    } catch {
      // invalid JSON-LD — record error in result, don't throw
    }
  }
  return results;
}
```

This is safe and sufficient: JSON-LD is always in `<script>` tags with a known type attribute, not scattered through DOM. [ASSUMED] based on spec; microdata (itemprop/itemtype) is rare enough that a minimal regex extractor suffices for the validator use case.

### Pattern 5: SSR/CSR Detection (Ported + Fixed)

The Python heuristic has a known bug: it only flags CSR when BOTH `root div text < 50 chars` AND `total word count < 200`. This misses SPA shells with large static copy. The port should improve the signal set:

```typescript
const HYDRATION_MARKERS = [
  "__NEXT_DATA__",           // Next.js
  "data-reactroot",          // React
  "ng-version",              // Angular
  "__NUXT_DATA__",           // Nuxt
  "data-server-rendered",    // Nuxt SSR flag
  "__svelte",                // Svelte
  "x-data",                  // Alpine.js
  "v-cloak",                 // Vue CSR indicator
] as const;

const FRAMEWORK_ROOT_PATTERN = /id=["'](?:app|root|__next|__nuxt)["']/i;

export function detectRendering(html: string): RenderingResult {
  const signals: string[] = [];
  // count visible text characters outside <script>/<style>
  const strippedHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                           .replace(/<style[\s\S]*?<\/style>/gi, "");
  const textContent = strippedHtml.replace(/<[^>]+>/g, " ");
  const wordCount = textContent.trim().split(/\s+/).filter(Boolean).length;

  const hasFrameworkRoot = FRAMEWORK_ROOT_PATTERN.test(html);
  const hydrationMarkers = HYDRATION_MARKERS.filter(m => html.includes(m));
  const scriptWeight = (html.match(/<script/gi) ?? []).length;

  // ... score signals to determine 'ssr'|'csr'|'hybrid'
}
```

### Anti-Patterns to Avoid

- **Throwing on missing data:** Return a typed result with an `errors: string[]` field. The Python conventions explicitly use result-accumulation, not exceptions, for expected failure modes. This is the right pattern for GEO audit functions.
- **Importing `node:fs` or `node:http` anywhere in `packages/core/src/`:** The package must run in browser-like environments (HOW may SSR/SSG). Keep to Web APIs only (`URL`, `URLSearchParams`, `TextDecoder`).
- **Hardcoding sitemap URL bugs from Python:** The Python sitemap URL reconstruction (`"http" + sitemap_url`) corrupts `https://...` sitemaps. Re-implement cleanly with `new URL(value)` validation.
- **Mutable `CITABILITY_WEIGHTS`:** Declare it `as const` and type it with `typeof CITABILITY_WEIGHTS`. Phase 4 prompt must reference the same object — mutation would silently drift.
- **Putting `"type": "module"` without updating tsconfig:** Add `"moduleResolution": "bundler"` or `"node16"` when using `"type": "module"` — otherwise TS relative imports without extensions will fail.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| robots.txt parsing | custom state machine | Port from Python with fixes | Python impl handles 90% of cases; known edge cases documented |
| URL construction / validation | `+` string concat | `new URL()` from stdlib | Handles scheme, port, path — avoids the Python sitemap bug |
| JSON-LD parsing | custom parser | `JSON.parse` on extracted string | JSON-LD payload is valid JSON — one-liner |
| Schema.org type definitions | invent field names | Copy from existing `schema/*.json` templates | Templates already exist in this repo |
| Citability weight system | arbitrary numbers | Port `score_passage` weights directly | Weights are research-backed (Ahrefs Dec 2025 study cited in Python source) |

**Key insight:** The Python source is the design document. Port it; don't reinvent.

---

## Common Pitfalls

### Pitfall 1: Dual-Package Hazard (CJS + ESM both loaded)
**What goes wrong:** Consumer imports both ESM and CJS versions of `@geo/core` in one process (e.g. one dep uses `require()`, another uses `import`). `CITABILITY_WEIGHTS` identity check (`===`) fails because there are two module instances.
**Why it happens:** Node's dual-package mode — two separate module graphs.
**How to avoid:** Use `exports` map with `"exports"` condition and avoid `instanceof` checks on types from the package. Since we're using plain constants and JSON-serializable results (D-06), this is low risk but worth knowing.
**Warning signs:** `CITABILITY_WEIGHTS === imported_weights` returns `false` unexpectedly.

### Pitfall 2: `"type": "module"` + `tsconfig.json` target mismatch
**What goes wrong:** tsup builds fine but TypeScript shows errors about `.js` extensions in imports, or the CJS output fails at runtime with `require is not defined`.
**Why it happens:** `"type": "module"` in `package.json` means `.js` = ESM. tsup's CJS output must use `.cjs` extension.
**How to avoid:** Set `tsup` options `format: ["esm", "cjs"]` — tsup automatically uses `.js` for ESM and `.cjs` for CJS.
**Warning signs:** `require` errors in consumers; `.js` import extensions resolving to CJS.

### Pitfall 3: Regex over HTML is order-dependent (SSR decompose pattern)
**What goes wrong:** Extracting JSON-LD after stripping `<script>` tags returns nothing.
**Why it happens:** The Python code has an explicit warning: structured data extraction MUST run before `decompose()`. Same applies to regex: extract JSON-LD first, then strip scripts for word-count.
**How to avoid:** In `detectRendering` and `computeCitabilityScore`, always extract structured data before running text-stripping regexes.
**Warning signs:** JSON-LD extraction returns `[]` on pages known to have structured data.

### Pitfall 4: robots.txt parsing — sitemap URL corruption
**What goes wrong:** `Sitemap: https://example.com/sitemap.xml` splits on first `:` yielding `https`, then prepend logic makes it `httphttps://...`.
**Why it happens:** The Python `split(":", 1)[1]` pattern strips the scheme. The defensive `if not startswith("http"): prepend "http"` then double-prepends.
**How to avoid:** Parse the full line value as `line.slice(directivePrefix.length).trim()` then validate with `new URL()`.
**Warning signs:** Sitemap URLs in result starting with `httphttps://`.

### Pitfall 5: `bun install` not hoisting workspace package
**What goes wrong:** Consumer can't import `@geo/core` even after `bun install`.
**Why it happens:** Workspace not listed in root `package.json` `workspaces` array, or package `name` in `packages/core/package.json` doesn't match `@geo/core`.
**How to avoid:** Ensure root `package.json` has `"workspaces": ["packages/*"]` (or explicit path), and `packages/core/package.json` has `"name": "@geo/core"`.
**Warning signs:** `Cannot find module '@geo/core'` at runtime.

---

## Code Examples

### Citability Weights — exportable typed const
```typescript
// Source: ported from scripts/citability_scorer.py section banners
export const CITABILITY_WEIGHTS = {
  answer_block_quality: 30,    // definition patterns, early answer, question heading
  self_containment:     25,    // optimal word count (134–167), low pronoun density, named entities
  structural_readability: 20,  // avg sentence length 10–20 words, list/number signals
  statistical_density:  15,    // %, $, numbers with context, year refs, named sources
  uniqueness_signals:   10,    // original data, case studies, tool mentions
} as const;

export type CitabilityWeightKey = keyof typeof CITABILITY_WEIGHTS;
// Sum: 100 — weights are exhaustive
```

### AI Crawler List (CORE-01)
```typescript
// Source: ported from scripts/fetch_page.py AI_CRAWLERS + fetch_robots_txt
export const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "anthropic-ai",
  "PerplexityBot",
  "CCBot",
  "Bytespider",
  "cohere-ai",
  "Google-Extended",
  "GoogleOther",
  "Applebot-Extended",
  "FacebookBot",
  "Amazonbot",
] as const;

export type AiCrawler = (typeof AI_CRAWLERS)[number];
```

### llms.txt Format (CORE-02)
```
# Site Name
> One-line description of the site.

## Section Name
- [Page Title](https://example.com/page): Brief description.
- [Page Title](https://example.com/page2): Brief description.

## Contact
- Website: https://example.com
- Email: contact@example.com
```
Format: Markdown. Only `# Title` is required. `> description`, `## Section`, `- [title](url): desc` are recommended. [CITED: https://llmstxt.org/]

### Robots.txt Result Shape (CORE-01)
```typescript
export interface RobotsResult {
  url: string;
  exists: boolean;
  content: string;
  aiCrawlerStatus: Record<AiCrawler, "ALLOWED" | "BLOCKED" | "PARTIALLY_BLOCKED" | "BLOCKED_BY_WILDCARD" | "ALLOWED_BY_DEFAULT" | "NOT_MENTIONED" | "NO_ROBOTS_TXT">;
  sitemaps: string[];
  errors: string[];
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Python BS4 for HTML parsing | Zero-dep regex / string ops in TS | This phase | Eliminates lxml/BS4 runtime dep |
| Flat `scripts/*.py` tools | `@geo/core` TS package with typed exports | This phase | Single source of truth for HOW + service |
| `requests.get` inline in every script | Injected `Fetcher` type contract | This phase | SSRF hardening in one place (Phase 2) |
| Implicit citability thresholds | `CITABILITY_WEIGHTS` exported const | This phase | Phase 4 LLM prompt references same weights |
| CJS-only or ESM-only | Dual ESM+CJS via tsup exports map | 2023+ standard | Both Node/Bun module systems covered |

**Deprecated/outdated patterns to avoid in the port:**
- `split(":", 1)` for robots.txt URL parsing → use `new URL()` validation
- Checking `has_ssr_content` with a single boolean threshold → multi-signal `{ rendering, confidence, signals[] }`
- `except Exception: pass` → typed error accumulation in `errors: string[]`

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Microdata (itemprop/itemtype) is rare enough in the 2-consumer use case that regex extraction suffices | Don't Hand-Roll | If consumers need full microdata support, a small runtime dep like `parse-microdata` may be needed in Phase 3+ |
| A2 | HOW (`hyperoptimizedwebsites`) is already a Bun workspace monorepo that can accept `workspace:*` links from this repo | Architecture Patterns | If HOW uses a different package manager or project structure, the linking strategy needs adjustment; may need `file:` path reference instead |
| A3 | `node:` built-ins (`URL`, `URLSearchParams`) are available in HOW's runtime environment | Standard Stack | If HOW targets pure browser without polyfills, need to use global `URL` without `node:` prefix |
| A4 | The llmstxt.org spec `# Title` is the only required field; all else optional | Code Examples | If spec has been updated with mandatory fields since research date, validator logic needs adjustment |

---

## Open Questions

1. **HOW workspace structure** — Is `hyperoptimizedwebsites` already a Bun monorepo with `packages/`? The plan should clarify whether `@geo/core` lives IN HOW's workspace or is linked via `file:` path from a sibling directory.
   - What we know: D-01 says "HOW consumes it via its own workspace/file link; this repo is the source of truth."
   - What's unclear: Is HOW's package manager Bun? Does it have a root `package.json` already?
   - Recommendation: Plan should include a task to verify HOW's setup and test the cross-repo link before declaring CORE-06 done.

2. **Content-block extraction for citability (no cheerio)** — The Python `analyze_page_citability` uses BS4 to walk heading → paragraph groups. A pure regex version over raw HTML is viable but must handle malformed/nested tags.
   - Recommendation: Use a simple two-pass approach: (1) regex-strip scripts/styles/nav/footer; (2) walk `<h[1-6]>`, `<p>`, `<ul>`, `<ol>` in source order using regex with lazy matching. Test against fixtures for correctness.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | Package manager, test runner, build | ✓ | 1.3.14 | npm (D-02 is Bun workspaces, no fallback) |
| Node.js | tsup build, vitest | ✓ | v22.16.0 | — |
| tsup | Build | ✓ (npm) | 8.5.1 | — |
| vitest | Test runner | ✓ (npm) | 4.1.8 | — |

**Missing dependencies with no fallback:** none
**Missing dependencies with fallback:** none

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.8 |
| Config file | `packages/core/vitest.config.ts` (Wave 0 gap — create) |
| Quick run command | `bun vitest run --project packages/core` |
| Full suite command | `bun vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORE-01 | `checkRobots` parses AI crawler allow/block from robots.txt text | unit | `bun vitest run packages/core/src/__tests__/robots.test.ts` | ❌ Wave 0 |
| CORE-01 | `checkRobots` returns NO_ROBOTS_TXT when fetcher returns 404 | unit | same | ❌ Wave 0 |
| CORE-01 | robots.txt sitemap URL correctly handles `https://` prefix (bug fix) | unit | same | ❌ Wave 0 |
| CORE-02 | `generateLlmsTxt` emits `# Title`, `> desc`, `## Section`, `- [title](url)` | unit | `bun vitest run packages/core/src/__tests__/llmstxt.test.ts` | ❌ Wave 0 |
| CORE-02 | `validateLlmsTxt` detects missing title / sections / links | unit | same | ❌ Wave 0 |
| CORE-03 | `getSchemaTemplates("Organization")` returns typed template with required fields | unit | `bun vitest run packages/core/src/__tests__/schema.test.ts` | ❌ Wave 0 |
| CORE-03 | `validateStructuredData` extracts JSON-LD from fixture HTML | unit | same | ❌ Wave 0 |
| CORE-04 | `computeCitabilityScore` returns 0–100 + 5-category breakdown | unit | `bun vitest run packages/core/src/__tests__/citability.test.ts` | ❌ Wave 0 |
| CORE-04 | `CITABILITY_WEIGHTS` values sum to 100 | unit | same | ❌ Wave 0 |
| CORE-05 | `detectRendering` returns `csr` for CSR fixture HTML | unit | `bun vitest run packages/core/src/__tests__/rendering.test.ts` | ❌ Wave 0 |
| CORE-05 | `detectRendering` returns `ssr` for SSR fixture HTML | unit | same | ❌ Wave 0 |
| CORE-06 | Package `exports` map resolves for both ESM `import` and CJS `require` | smoke | `bun run build && node -e "require('./dist/index.cjs')"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `bun vitest run packages/core/src/__tests__/<module>.test.ts`
- **Per wave merge:** `bun vitest run` (full suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/core/vitest.config.ts` — framework config
- [ ] `packages/core/src/__tests__/robots.test.ts` — CORE-01
- [ ] `packages/core/src/__tests__/llmstxt.test.ts` — CORE-02
- [ ] `packages/core/src/__tests__/schema.test.ts` — CORE-03
- [ ] `packages/core/src/__tests__/citability.test.ts` — CORE-04
- [ ] `packages/core/src/__tests__/rendering.test.ts` — CORE-05
- [ ] `packages/core/fixtures/ssr-page.html` — SSR fixture
- [ ] `packages/core/fixtures/csr-page.html` — CSR fixture (React/Next.js `<div id="root"></div>` with empty body)
- [ ] `packages/core/fixtures/schema-rich.html` — page with JSON-LD Organization + Article
- [ ] `packages/core/fixtures/llmstxt-valid.txt` — valid llms.txt sample

---

## Security Domain

`security_enforcement` not explicitly set → treated as enabled.

This phase is zero-network-I/O. The `@geo/core` package performs no HTTP calls — all security risk is deferred to Phase 2 (the `Fetcher` implementation). However, the types this phase defines determine what Phase 2 must validate:

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes (partial) | Validate `url` input to `checkRobots` is parseable via `new URL()` before calling fetcher |
| V6 Cryptography | no | — |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| ReDoS via complex regex on adversarial HTML | DoS | Use possessive/atomic quantifiers where available; add input length guard (max 5MB HTML) before regex pass |
| Prototype pollution via `JSON.parse` of JSON-LD | Tampering | JSON-LD content is parsed with `JSON.parse` which is safe in V8; `__proto__` properties land on the parsed object, not the prototype chain — no risk in modern Node/Bun |
| Path traversal via fixture file names in tests | Information disclosure | Fixtures are committed, not user-supplied — no risk |

**Note:** SSRF, redirect validation, size caps, DNS rebinding — all deferred to Phase 2's `Fetcher`. The `FetchResult` type this phase defines must include `redirectChain` so Phase 2 can enforce the redirect SSRF check and surface it to callers.

---

## Sources

### Primary (HIGH confidence)
- **In-repo source code** — `scripts/fetch_page.py`, `scripts/citability_scorer.py`, `scripts/llmstxt_generator.py`, `schema/*.json` — read directly; all heuristics extracted from live code
- **npm registry** — `npm view tsup`, `vitest`, `typescript`, `@types/node` — versions and registry existence verified
- **tsup documentation** — https://tsup.egoist.dev/ — dual format config and exports map pattern

### Secondary (MEDIUM confidence)
- [llmstxt.org](https://llmstxt.org/) — llms.txt format spec; confirmed: `# Title` required, `> desc`, `## Section`, `- [title](url)` recommended
- [Bun workspaces docs](https://bun.com/docs/pm/workspaces) — `workspace:*` protocol confirmed

### Tertiary (LOW confidence)
- WebSearch results on GEO citability signals — corroborates Python source weights but no single authoritative spec; weights treated as project-internal constants

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified on npm registry with multi-year history
- Architecture / Fetcher seam: HIGH — based on locked decision D-05 + direct Python source read
- Heuristic port logic: HIGH — Python source fully readable, weights extracted directly
- llms.txt format: MEDIUM — spec confirmed via official site but specification is young (Sept 2024) and may evolve
- Bun workspace cross-repo linking with HOW: LOW — HOW's package structure not verified this session (A2)

**Research date:** 2026-06-02
**Valid until:** 2026-09-01 (stable tooling; llms.txt spec may receive minor updates but format is stable)
