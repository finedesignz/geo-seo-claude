# Phase 1: @geo/core — Deterministic Package - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver `@geo/core`: a zero-runtime-dependency TypeScript package exposing the deterministic ~80% of a GEO audit as pure functions — robots/crawlability, llms.txt generation, schema.org templates + validator, citability heuristic, and SSR/CSR detection. It must be importable by BOTH the Bun+Hono service (this repo) and `../hyperoptimizedwebsites` with **no LLM calls** anywhere in the package.

Covers CORE-01 … CORE-06. Does NOT include: the hardened SSRF fetcher (Phase 2), Postgres/persistence (Phase 3), the scoring LLM call (Phase 4), or the HTTP API (Phase 5).
</domain>

<decisions>
## Implementation Decisions

### Package layout & build
- **D-01:** `@geo/core` lives as a workspace package at `packages/core/` in this repo, exposed via a root `package.json` workspaces array (Bun workspaces). HOW consumes it via its own workspace/file link; this repo is the source of truth. (recommended default)
- **D-02:** Build target = ESM-first dual output (ESM + CJS) with type declarations, via `tsup` (dev dependency only — does not violate zero *runtime* deps). `exports` map in package.json. `"type": "module"`. (recommended default)
- **D-03:** Strict TS config (`strict: true`, `noUncheckedIndexedAccess`). Node/Bun ≥ current LTS target. (recommended default)

### Zero-dep boundary & fetch injection
- **D-04:** "Zero-dependency" = zero *runtime* dependencies. Dev deps (tsup, vitest, @types) are allowed. HTML/robots/llms parsing is hand-rolled with the standard library + minimal regex/DOM-free string parsing — NO cheerio/jsdom/lxml-equivalent at runtime. (recommended default)
- **D-05:** **Fetch is injected, not owned.** Every function that needs network bytes accepts a caller-provided `fetcher: (url) => Promise<FetchResult>` (or pre-fetched HTML/bytes). `@geo/core` performs NO raw network I/O itself — this keeps it zero-dep and lets Phase 2's hardened SSRF fetcher be the single fetch path. Package ships a thin `FetchResult`/`Fetcher` type contract only. (recommended default — critical Phase 1↔2 seam)

### Function contracts (CORE-01..05)
- **D-06:** Each capability is a pure function returning a typed, JSON-serializable result object with explicit sub-fields (no throwing for "page not crawlable" — that's a normal result; throw only on programmer error). (recommended default)
- **D-07:** **Citability heuristic (CORE-04)** = a documented, weighted composite of deterministic sub-scores (e.g. structured-data presence, heading hierarchy, content-to-markup ratio, llms.txt presence, crawlability). Weights live in a single exported, versioned `CITABILITY_WEIGHTS` constant so the scoring prompt (Phase 4) can reference the same source of truth. Output is 0–100 sub-score + per-signal breakdown. (recommended default)
- **D-08:** **SSR/CSR detection (CORE-05)** = heuristic over the initial HTML: ratio of rendered text/content nodes present in raw HTML vs. script-bundle weight + known framework hydration markers (`__NEXT_DATA__`, `data-reactroot`, `ng-version`, etc.). Returns `{ rendering: 'ssr'|'csr'|'hybrid', confidence, signals[] }`. (recommended default)
- **D-09:** **schema.org (CORE-03)** = template generators for the common types (Organization, WebSite, Article, Product, BreadcrumbList, FAQPage) + a validator that extracts JSON-LD/microdata from page HTML and reports presence/validity per template. (recommended default)
- **D-10:** **llms.txt (CORE-02)** generated from crawl data following the llms.txt convention (title, summary, sectioned links). (recommended default)

### Porting from Python
- **D-11:** Logic is **ported, not wrapped** — the Python `scripts/*.py` heuristics inform the TS implementation but no Python is executed. Port behavior, re-derive thresholds in TS, cover with tests. (recommended default)

### Testing
- **D-12:** Vitest unit tests per function with fixture HTML inputs (committed sample pages: one SSR, one CSR, one with/without schema, one with/without llms.txt). Deterministic — no network in tests (fetcher is mocked/fixtures). Target meaningful coverage of each CORE-0x function. (recommended default)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project / requirements
- `.planning/PROJECT.md` — All-TS decision, `@geo/core` zero-dep shared-package decision, scoring-is-a-single-SDK-call decision (Key Decisions table)
- `.planning/REQUIREMENTS.md` §"Shared Core (`@geo/core`)" — CORE-01..06 locked requirements
- `.planning/ROADMAP.md` — Phase 1 goal + dependency graph

### Codebase maps (existing Python to port)
- `.planning/codebase/STACK.md` — current Python tool stack
- `.planning/codebase/STRUCTURE.md` — where `scripts/*.py` live
- `.planning/codebase/CONVENTIONS.md` — JSON-to-stdout tool conventions to preserve in shape
- `.planning/codebase/CONCERNS.md` — SSRF / no-size-cap in `fetch_page.py` (informs the Phase 2 seam, D-05)
- `scripts/fetch_page.py` — existing SSR/HTML fetch+parse behavior to port
- `scripts/brand_scanner.py` + sibling `scripts/*.py` — heuristics to port

### External conventions
- llms.txt spec (https://llmstxt.org) — format for CORE-02
- schema.org type definitions — for CORE-03 templates

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/fetch_page.py`: SSR/HTML parse behavior + citability-ish heuristics — port logic to TS (do not call Python).
- `scripts/*.py` scrapers: source heuristics for crawl/robots and content analysis.

### Established Patterns
- Stateless tools emitting JSON — `@geo/core` mirrors this with pure functions returning JSON-serializable objects.

### Integration Points
- Phase 2 supplies the `Fetcher` implementation that satisfies D-05's injected-fetch contract.
- Phase 4 scoring prompt consumes `CITABILITY_WEIGHTS` (D-07) and the typed findings objects.
- HOW imports the same package inline (CORE-06 / CONS-01).

</code_context>

<specifics>
## Specific Ideas

Single source of truth for scoring weights (D-07) so the deterministic citability sub-score and the Phase 4 LLM prompt never drift. Fetch-injection seam (D-05) is the most important contract this phase establishes.
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Hardened fetcher → Phase 2; scoring → Phase 4; publishing to a registry beyond workspace linking → not needed for the 2-consumer internal model.)
</deferred>

---

*Phase: 1-@geo/core — Deterministic Package*
*Context gathered: 2026-06-02*
