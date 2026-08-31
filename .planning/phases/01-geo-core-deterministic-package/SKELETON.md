# Walking Skeleton — geo-api / @geo/core

**Phase:** 1
**Generated:** 2026-06-02

## Capability Proven End-to-End

A consumer can `import { normalizeUrl, AI_CRAWLERS } from "@geo/core"` (ESM) **and** `require("@geo/core")` (CJS) from the built, workspace-linked package, call a real function, and get a deterministic result — proving the workspace → tsup dual-build → vitest → public `exports` map stack works end-to-end with zero runtime dependencies.

> This is a library, not a UI app: the "full stack" is workspace resolution + dual-format build + type seam + test runner + public package surface. There is no routing/DB/UI/deploy tier in this package (network I/O is injected per D-05; persistence is Phase 3; HTTP is Phase 5).

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Monorepo / package mgr | Bun workspaces, `packages/core/` at repo root | D-01 — this repo is source of truth; HOW consumes via workspace/file link |
| Build | `tsup` dual ESM+CJS + `.d.ts`/`.d.cts`, `"type": "module"`, `exports` map (types-first) | D-02 — both Node/Bun ESM and CJS consumers; dev-dep only, no runtime-dep violation |
| Language config | TypeScript strict, `noUncheckedIndexedAccess`, `moduleResolution: bundler`, current LTS | D-03 |
| Runtime deps | **Zero** — stdlib only (`URL`, regex, `JSON.parse`); DOM-free string parsing, no cheerio/jsdom | D-04 — verified against built manifest in Plan 06 |
| Network I/O | **Injected** `Fetcher = (url) => Promise<FetchResult>`; package does NO network I/O | D-05 — the load-bearing Phase 1↔2 seam; Phase 2 supplies a conforming hardened fetcher |
| Error model | Result-accumulation: typed JSON-serializable results with `errors: string[]`; throw only on programmer error | D-06 — ported from Python conventions |
| Scoring weights | Single exported `CITABILITY_WEIGHTS as const` (sums to 100) | D-07 — single source of truth shared with Phase 4 prompt; sum-to-100 test guards drift |
| Testing | vitest, committed fixture HTML, mocked fetcher, no network | D-12 |
| Directory layout | `packages/core/src/{index,types,robots,llmstxt,schema,citability,rendering}.ts` + `src/__tests__/*` + `fixtures/` | RESEARCH Recommended Structure; one module per CORE capability |
| Porting | Logic ported from `scripts/*.py`, not wrapped; thresholds re-derived in TS, documented bugs fixed | D-11 |

## Stack Touched in Phase 1

- [x] Package scaffold (Bun workspace root, @geo/core manifest, tsconfig, tsup, vitest) — Plan 00
- [x] Type seam — `FetchResult`/`Fetcher` (D-05) + six result-type stubs defined — Plan 00
- [x] One real function exercised end-to-end through the public barrel (`normalizeUrl`, `AI_CRAWLERS`) with a passing test — Plan 00
- [x] Dual build emits ESM + CJS + `.d.ts` and resolves via the `exports` map (verified in both module systems) — Plan 00 (smoke) + Plan 06 (gate)
- [x] Local full run command documented: `bun run --cwd packages/core test -- --run` and `bun run --cwd packages/core build`

## Out of Scope (Deferred to Later Slices)

- Hardened SSRF fetcher / any real network I/O — **Phase 2** (the `Fetcher` implementation conforming to D-05's contract)
- Postgres persistence / job queue — **Phase 3**
- The LLM scoring call (consumes `CITABILITY_WEIGHTS` + findings) — **Phase 4**
- HTTP API (`/audit`, `/openapi.json`, `/docs`) — **Phase 5**
- Containerization / Coolify deploy — **Phase 6**
- Cron re-audit + HOW inline integration + ottolax HTTP consumer wiring — **Phase 7** (CORE-06 is structurally workspace-linkable now; full HOW wiring is Phase 7 per VALIDATION manual-only row)
- Microdata (itemprop/itemtype) full extraction — JSON-LD regex extraction only this phase (RESEARCH Assumption A1)
- Publishing to a public npm registry — not needed for the internal 2-consumer workspace model

## Subsequent Slice Plan

Each later phase adds one vertical slice without altering Phase 1's architectural decisions (the type seam and zero-dep boundary are frozen):

- Phase 2: A URL fetch is SSRF-safe — implements the `Fetcher` contract this phase defined.
- Phase 3: An audit job durably persists in Postgres and is claimable via SKIP LOCKED.
- Phase 4: A worker runs `@geo/core` checks → single structured Anthropic SDK scoring call → persists a 0–100 score.
- Phase 5: A consumer can `POST /audit` and `GET /audit/{id}` over an authenticated REST API with OpenAPI/Scalar docs.
- Phase 6: The API + worker run as Coolify container services from env-sourced secrets.
- Phase 7: A cron re-audits configured sites; HOW imports `@geo/core` inline; ottolax triggers audits over HTTP.
