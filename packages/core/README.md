# @geo/core

Deterministic, zero-runtime-dependency primitives for GEO (Generative Engine Optimization) analysis.

## Status

Phase 1 complete. Full suite green. Dual ESM + CJS build passing.

| Capability | Export | CORE- |
|---|---|---|
| Robots/crawl-gate | `checkRobots` | 01 |
| llms.txt generation + validation | `generateLlmsTxt`, `validateLlmsTxt` | 02 |
| Schema templates + structured data | `getSchemaTemplates`, `validateStructuredData` | 03 |
| Citability scoring | `computeCitabilityScore`, `scorePassage`, `CITABILITY_WEIGHTS` | 04 |
| Rendering detection | `detectRendering` | 05 |
| Dual ESM+CJS consumability | exports map | 06 |

## Install (Bun workspace)

```json
{
  "dependencies": {
    "@geo/core": "workspace:*"
  }
}
```

```bash
bun install
```

## Usage

### ESM (Node 18+, Bun, bundlers)

```typescript
import {
  checkRobots,
  generateLlmsTxt,
  validateLlmsTxt,
  getSchemaTemplates,
  validateStructuredData,
  computeCitabilityScore,
  scorePassage,
  detectRendering,
  CITABILITY_WEIGHTS,
  AI_CRAWLERS,
  normalizeUrl,
} from "@geo/core";
```

### CJS (CommonJS)

```javascript
const {
  checkRobots,
  computeCitabilityScore,
  detectRendering,
} = require("@geo/core");
```

## Zero Runtime Dependencies

`@geo/core` has **no runtime dependencies**. The `package.json` `dependencies` field is intentionally absent. This is enforced by an automated assertion in `scripts/verify-consumable.cjs` and verified on every build.

`devDependencies` (`tsup`, `vitest`, `typescript`) are build-time only and not bundled.

## Injected-Fetcher Contract

`@geo/core` performs **no network I/O**. Every function that needs to retrieve remote content accepts a caller-supplied `Fetcher`:

```typescript
type Fetcher = (url: string) => Promise<FetchResult>;
type FetchResult = { status: number; body: string; headers: Record<string, string> };
```

The caller owns the HTTP layer (retries, timeouts, auth headers, caching). This keeps the package deterministic and testable without mocking globals.

Example:

```typescript
import { checkRobots } from "@geo/core";

const fetcher: Fetcher = async (url) => {
  const res = await fetch(url);
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body, headers };
};

const result = await checkRobots("https://example.com", "GPTBot", fetcher);
```

Full HOW-layer wiring (Phase 2) and cross-repo service integration (Phase 7) build on top of this seam.

## Public API

### `checkRobots(url, crawlerName, fetcher): Promise<RobotsResult>`
Fetches and parses `robots.txt`, returning allow/disallow status for the named crawler.

### `generateLlmsTxt(data: CrawlData, fetcher): Promise<LlmsTxtResult>`
Generates an `llms.txt` manifest from structured crawl data.

### `validateLlmsTxt(content: string): LlmsTxtValidationResult`
Validates an `llms.txt` file against the spec format.

### `getSchemaTemplates(schemaType: SchemaType): SchemaTemplateResult`
Returns schema.org JSON-LD templates for the given type.

### `validateStructuredData(html: string): StructuredDataValidationResult`
Extracts and validates all JSON-LD blocks in an HTML document.

### `computeCitabilityScore(page: PageData): CitabilityResult`
Computes a weighted citability score (0–100) across all dimensions.

### `scorePassage(text: string): PassageResult`
Scores a single text passage for AI citability.

### `detectRendering(html: string, fetchedHtml?: string): RenderingResult`
Detects SSR vs CSR rendering mode from HTML signals.

### Constants

- `CITABILITY_WEIGHTS` — weighted breakdown summing to 100 (type `Record<CitabilityWeightKey, number>`)
- `AI_CRAWLERS` — canonical list of known AI crawler user-agent patterns
- `normalizeUrl(url: string): string` — normalize a URL for consistent keying

## Build

```bash
bun run build   # emits dist/index.js (ESM), dist/index.cjs (CJS), dist/index.d.ts, dist/index.d.cts
bun run test    # vitest full suite
node scripts/verify-consumable.mjs   # ESM smoke
node scripts/verify-consumable.cjs   # CJS smoke + zero-dep assertion
```
