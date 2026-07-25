# Coding Conventions

**Analysis Date:** 2026-07-24

Scope: the TypeScript monorepo under `packages/` (`@geo/core`, `@geo/fetch`, `@geo/db`, `@geo/api`, `@geo/worker`, `@geo/cron`) plus `examples/`. Legacy Python/skill assets (`geo/`, `skills/`, `agents/`, `scripts/`, root `tests/`) do not follow these conventions and are not the target for new code.

## Naming Patterns

**Packages:**
- Scoped `@geo/<name>`, directory `packages/<name>`, `version` pinned at `0.1.0` across all packages.

**Files:**
- `kebab-case.ts` for multi-word modules: `safe-fetcher.ts`, `ip-validator.ts`, `dns-resolve.ts`, `cli-scorer.ts`, `pglite-executor.ts`.
- Single-word modules stay bare: `citability.ts`, `robots.ts`, `schema.ts`, `dal.ts`, `worker.ts`.
- Tests mirror the module name: `src/<mod>.ts` → `src/__tests__/<mod>.test.ts`.
- Fixed per-package files: `src/index.ts` (public barrel), `src/main.ts` (process entry, only in packages with a `bin`), `src/types.ts`, `tsup.config.ts`, `vitest.config.ts`.

**Functions:**
- `camelCase`. Factories are `create*` returning a plain object of closures, never a class: `createSafeFetcher`, `createAuditDal`, `createTestServer`, `makePgliteDb`, `makePgliteExecutor`.
- Assertions/guards use `assert*` / `is*` / `validate*`: `assertEnv` (`packages/worker/src/env.ts`), `isBlockedIP` (`packages/fetch/src/ip-validator.ts`), `validateUrlHost` (`packages/fetch`).
- Resolvers/builders use `resolve*` / `build*`: `resolveScoringProvider`, `buildErrorResult` (`packages/fetch/src/errors.ts`).

**Variables:**
- `camelCase` locals, `SCREAMING_SNAKE_CASE` module constants: `MAX_HTML_BYTES`, `CITABILITY_WEIGHTS`, `MIGRATIONS_DIR`, `PUBLIC_IP`.
- Env vars read only via bracket access: `process.env["ANTHROPIC_API_KEY"]`, never `process.env.ANTHROPIC_API_KEY` (required under `noUncheckedIndexedAccess`).

**Types:**
- `PascalCase` for `interface` / `type`: `FetchResult`, `CitabilityResult`, `PageData`, `AuditDal`, `DbHandle`, `ScoringProvider`.
- Enum-like values use a frozen object + a same-named type alias, never a TS `enum`:
  ```ts
  export const FetchErrorCode = { SSRF_BLOCKED_IP: "SSRF_BLOCKED_IP", /* ... */ } as const;
  export type FetchErrorCode = (typeof FetchErrorCode)[keyof typeof FetchErrorCode];
  ```
  (`packages/fetch/src/errors.ts`). Weight/config tables use `Object.freeze({...} as const)` (`packages/core/src/citability.ts`).
- Data-shape field names crossing the scoring/report boundary are `snake_case` (`word_count`, `total_score`, `answer_block_quality`) because they are ported from the Python scorer and appear verbatim in LLM prompts and JSON output. Keep snake_case for anything serialized to a report or prompt; use camelCase for internal-only fields (`blocksAnalyzed`, `redirectChain`).

## Code Style

**Formatting:**
- No Prettier/ESLint/Biome config exists anywhere in the repo. Style is convention-enforced only. Match the surrounding file: 2-space indent, double quotes, semicolons, trailing commas in multi-line literals, ~90-column soft wrap.

**TypeScript:**
- Every package has an identical `tsconfig.json` (see `packages/core/tsconfig.json`): `target ES2022`, `module ESNext`, `moduleResolution: "bundler"`, `strict: true`, **`noUncheckedIndexedAccess: true`**, `declaration` + `declarationMap` + `sourceMap`, `rootDir: ./src`, `outDir: ./dist`, `include: ["src/**/*.ts"]`.
- `noUncheckedIndexedAccess` is load-bearing: any array/record index yields `T | undefined`. Narrow it; use `!` only in test code where the shape is known (`mock.calls[0]![2]`).
- `type: "module"` everywhere; dual ESM/CJS output comes from tsup, never hand-written CJS.

**Build:**
- `tsup` per package (`packages/*/tsup.config.ts`), emitting `dist/index.js` + `dist/index.cjs` + `.d.ts` / `.d.cts`. `package.json` publishes `exports` (import/require conditions), `main`/`module`/`types`, and `files: ["dist"]` (`@geo/db` also ships `migrations`).
- Executable packages (`api`, `cron`, `worker`) declare `bin` → `./dist/main.js`.
- Dependency versions are **exact-pinned** (no `^`/`~`) in every `package.json`; workspace links use `workspace:*`.

## Import Organization

**Order** (see `packages/api/src/routes/audit-post.ts`, `packages/fetch/src/__tests__/safe-fetcher.test.ts`):
1. External deps (`@hono/zod-openapi`, `vitest`, `undici`, `postgres`)
2. Node builtins with the `node:` prefix (`node:crypto`, `node:path`) — always prefixed
3. Workspace packages (`@geo/core`, `@geo/db`, `@geo/fetch`)
4. Relative imports (`../app.js`, `../errors.js`)

**Extensions:**
- **Relative imports always carry a `.js` extension**, even in `.ts` source: `import { FetchErrorCode } from "../errors.js";`. Omitting it breaks resolution.

**Path aliases:**
- None. Cross-package imports go through `@geo/*` workspace names.
- One deliberate exception: `packages/api/src/__tests__/pglite-helper.ts` reaches into `@geo/db` **source** by relative path (`../../../db/src/__tests__/harness.js`) so tests exercise the real DAL/migrations rather than a stale `dist`. Restrict this pattern to test helpers.

**Type-only imports:**
- Use `import type { ... }` for anything used only in type position: `import type { FetchResult } from "@geo/core";`.

## Error Handling

**Two distinct idioms — pick by layer:**

1. **Result objects for expected/adversarial failures.** `@geo/fetch` never throws on a fetch failure: every failure mode maps to one of exactly ten `FetchErrorCode` values and returns a well-formed `FetchResult` via `buildErrorResult(url, code, redirectChain)` with `status: 0` and `error: code` (`packages/fetch/src/errors.ts`). Callers branch on `result.error`, not `try/catch`. Add a new failure mode by adding a code, not by throwing.
2. **Throw for programmer/config errors.** Startup env validation throws immediately with a message naming the variable and the fix (`packages/worker/src/env.ts`):
   ```ts
   throw new Error(
     "@geo/worker: ANTHROPIC_API_KEY is required for SCORING_PROVIDER=api but not set. ...",
   );
   ```

**Rules:**
- Prefix error messages with the package name (`@geo/worker: ...`) and make them actionable — state what to set.
- **Never echo a secret value in an error or log.** Name the env var only (explicit in `packages/worker/src/env.ts`).
- Env validation has **no side effects on import** — export `assertEnv()` and call it at process start from `src/main.ts`.
- Degraded-but-usable config warns instead of throwing (`console.warn` when `SCORING_PROVIDER=cli` without `CLAUDE_CODE_OAUTH_TOKEN`).
- Input-size guards run before any regex/parse work (`MAX_HTML_BYTES`, `packages/core/src/citability.ts`); oversize input returns a result with a populated `errors: string[]` rather than throwing.
- Regex over untrusted input must use bounded/lazy quantifiers (ReDoS guard, documented in the `citability.ts` header).

## Logging

**Framework:** none — `console.warn` / `console.error` only, and sparingly (47 combined `throw new Error` + `console.*` sites across all non-test source).

**Patterns:**
- Prefix with a bracketed component tag: `console.warn("[worker] SCORING_PROVIDER=cli but ...")`.
- Log at startup/config boundaries and unrecoverable-but-continuing paths. No per-request or hot-loop logging; `@geo/core` stays silent (zero-dep pure package).

## Comments

**File-header block on every module** — the strongest convention in the codebase. Every `src/*.ts` and every test opens with a `/** ... */` header giving: module name, the requirement/decision id it implements, what it does, and any security or determinism constraint. Examples:

- `packages/core/src/citability.ts` — `citability.ts — CORE-04`, notes zero runtime deps, the Python port origin (D-11), the ReDoS guard.
- `packages/fetch/src/errors.ts` — `@geo/fetch — structured error model (SEC-05)`, states `buildErrorResult() never throws`.
- `packages/db/src/__tests__/harness.ts` — documents both test modes, the PGlite single-connection limitation, and `NEVER set DATABASE_URL to a production connection string when running tests.`

Reference the requirement/decision id (`CORE-04`, `SEC-05`, `D-07`, `T-04-INFO`, `WORK-01`, `DEPLOY-04`) in the header when the module exists to satisfy one.

**Section dividers** separate concerns inside a file:
```ts
// ---------------------------------------------------------------------------
// Error codes (SEC-05)
// ---------------------------------------------------------------------------
```

**JSDoc on exports:** every exported function/const gets at least a one-line `/** ... */`. Document invariants ("never throws", "each call returns an independent database"), not the signature.

**Inline comments** explain *why* — a non-obvious library contract (`// undici MockAgent reply: third arg is { headers: ... }`) or a deliberate deviation. No commented-out code.

## Function Design

**Size:** small and single-purpose; scoring categories split into one `score<Category>` helper each (`scoreAnswerBlockQuality`, ...) rather than one large function.

**Parameters:**
- Positional for 1–3 required args (`buildErrorResult(url, code, redirectChain = [])`).
- A single options object for factories and anything with optional wiring: `createSafeFetcher({ resolver, _testDispatcher })`.
- Trailing optional params get inline defaults, which may call a resolver: `assertEnv(provider: ScoringProvider = resolveScoringProvider())`.

**Dependency injection over module mocking.** Every side-effecting dependency (DNS resolver, undici dispatcher, SQL executor, `spawn`, the Anthropic client) is an injectable parameter typed by an interface, so tests pass a plain object instead of `vi.mock`. Test-only seams are underscore-prefixed and documented as such: `_testDispatcher`. Preserve this — new I/O must be injectable.

**Return values:**
- Async I/O returns `Promise<T>`; fallible I/O returns a result object carrying an `error` code (see Error Handling), not a thrown exception.
- Return explicit `void` on procedures (`assertEnv(...): void`).

## Module Design

**Exports:**
- Named exports only. No `export default` in any `src/*.ts`.
- `src/index.ts` is the public barrel and the only surface consumers may import. Each package has an `exports.test.ts` / `skeleton.test.ts` asserting the barrel's shape, so adding a public export means updating that test.
- `src/main.ts` holds the process entry for `bin` packages and stays thin — read env, `assertEnv()`, wire deps, start.

**Barrel files:** exactly one per package (`src/index.ts`). No nested barrels; import intra-package modules by relative path with the `.js` extension.

**Layering:** `@geo/core` has zero runtime dependencies and must stay pure (no network, no LLM, no fs). Anything needing I/O belongs in `@geo/fetch`, `@geo/db`, or `@geo/worker`.

---

*Convention analysis: 2026-07-24*
