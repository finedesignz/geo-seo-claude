# Testing Patterns

**Analysis Date:** 2026-07-24

## Test Framework

**Runner:**
- **Vitest 4.1.8** — pinned identically in every package's `devDependencies`. Not `bun test`, not Jest; Bun is only the package manager / script runner (`bun.lock`, `bun run scripts/...`).
- Config: one `vitest.config.ts` per package (`packages/*/vitest.config.ts` + `examples/vitest.config.ts`). All are the same nine lines:
  ```ts
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    test: {
      include: ["src/__tests__/**/*.test.ts"],
      environment: "node",
      watch: false,
    },
  });
  ```
  `watch: false` means `vitest` is already a one-shot run in CI and locally.

**Assertion library:**
- Vitest's built-in `expect`. No chai/sinon/testing-library.

**Run commands:**
```bash
# whole monorepo (bun workspaces; packages/* + examples)
bun install

# one package (cwd = packages/<name>)
bun run test                 # vitest, single pass (watch is disabled in config)
npx vitest src/__tests__/safe-fetcher.test.ts   # single file
npx vitest -t "happy path"                      # single test by name

# real-Postgres tests (normally skipped)
ALLOW_DB_TESTS=1 DATABASE_URL=postgres://.../geo_test bun run test
```
There is **no root-level test script** — root `package.json` is only `{ "private": true, "workspaces": ["packages/*", "examples"] }`. Running the whole suite means iterating packages (`for d in packages/*; do (cd $d && bun run test); done`). There is also **no CI workflow** (`.github/workflows` does not exist), so nothing runs these automatically.

## Test File Organization

**Location:**
- Co-located per package under `src/__tests__/`. Never a top-level `tests/` dir for TS code — the root `tests/` holds legacy Python (`test_fetch_page_ssr.py`) and a markdown results file; the root `test` file is a 2-byte `ok` stub. Neither is part of the Vitest suite.

**Naming:**
- `<module>.test.ts`, one per source module: `safe-fetcher.ts` → `src/__tests__/safe-fetcher.test.ts`.
- Non-test helpers live in the same `__tests__/` dir without the `.test` infix (`harness.ts`, `pglite-executor.ts`, `pglite-helper.ts`) — the `include` glob ignores them.
- `@geo/fetch` additionally keeps reusable network fakes outside `src/` in `packages/fetch/test/helpers/` (`mock-resolver.ts`, `test-server.ts`).

**Structure:**
```
packages/<pkg>/
├── src/
│   ├── <module>.ts
│   └── __tests__/
│       ├── <module>.test.ts     # matched by include glob
│       ├── skeleton.test.ts     # package wiring / barrel smoke
│       ├── exports.test.ts      # public API surface assertions
│       └── harness.ts           # helper, not a test
├── test/helpers/                # @geo/fetch only — network fakes
└── vitest.config.ts
```

**Current inventory:** 41 test files, ~394 `it` blocks.

| Package | Files | `it` blocks |
|---------|-------|-------------|
| `@geo/core` | 7 | 106 |
| `@geo/fetch` | 10 | 83 + `it.each` tables in `ip-validator.test.ts` |
| `@geo/db` | 9 | 56 |
| `@geo/worker` | 6 | 72 |
| `@geo/api` | 7 | 40 |
| `@geo/cron` | 2 | 16 |
| `examples` | 1 (`how-inline-usage.test.ts`) | — |

## Test Structure

**Suite organization** — a documented header, then `describe` blocks named `"<unit> — <scenario>"`, split by section dividers:

```ts
/**
 * createSafeFetcher tests (Wave 1, Task 2)
 *
 * Happy-path uses undici MockAgent as the _testDispatcher seam so a
 * "public-looking" hostname can be served by a loopback handler without
 * disabling the IP deny-list. IP validation still runs against the injected
 * mock resolver.
 *
 * All tests are deterministic — no real DNS or network traffic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockAgent } from "undici";
import { createSafeFetcher } from "../safe-fetcher.js";
import { FetchErrorCode } from "../errors.js";
import { createStaticResolver } from "../../test/helpers/mock-resolver.js";

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createSafeFetcher — happy path", () => {
  it("returns status 200, lowercased headers, body, empty redirectChain", async () => {
    // ...
  });
});
```

**Patterns:**
- Every test file opens with the same JSDoc header convention as source: what is under test, which requirement/wave it covers, and any determinism/safety claim ("no real DNS or network traffic").
- Imports use the `.js` extension on relative paths, same as source.
- `it("<observable behavior>")` — full sentences describing the assertion, not the method name.
- Local factory helpers (`buildMockDispatcher`, `replyOpts`) are declared at the top of the file under a `// Helpers` divider.
- Table-driven cases use `it.each` — see `packages/fetch/src/__tests__/ip-validator.test.ts` (6 `it.each` tables covering blocked/allowed IP ranges).
- Setup/teardown via `beforeAll`/`afterAll` for servers and DB handles; per-test isolation for DB comes from creating a fresh PGlite instance rather than truncating.

## Mocking

**Framework:** none beyond Vitest's `vi`. **`vi.mock` is deliberately not used** — `packages/worker/src/types.ts` states the client interfaces exist so they can be "faked in tests without `vi.mock`", and `packages/worker/src/__tests__/scorer.test.ts` says `vi.mock('@anthropic-ai/sdk') is NOT used`.

**Preferred pattern — inject a hand-rolled fake through the factory's options object:**

```ts
// Anthropic client fake (packages/worker/src/__tests__/scorer.test.ts)
const client = {
  messages: {
    create: vi.fn().mockImplementation(async () => ({ /* ... */ })),
  },
};
// ...assert on the request that was built:
const callArg = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
```

```ts
// Network fake (packages/fetch/src/__tests__/safe-fetcher.test.ts)
const agent = new MockAgent();
agent.disableNetConnect();
agent.get(origin).intercept({ path }).reply(status, body, { headers });

const fetch = createSafeFetcher({
  resolver: createStaticResolver([PUBLIC_IP]),  // DNS fake
  _testDispatcher: agent,                        // undici seam
});
```

`vi.fn` / `vi.spyOn` are used only as spies on already-injected objects: `vi.spyOn(dal, "requeueJob")`, `vi.spyOn(dal, "completeJob").mockResolvedValue(false)` (`packages/worker/src/__tests__/pipeline.test.ts`), and `vi.fn()` for the `spawn` seam in `cli-scorer.test.ts` (asserting the argv and the env handed to the `claude` binary).

**What to mock:**
- Outbound network (undici `MockAgent`, `disableNetConnect()` always on).
- DNS resolution (`createStaticResolver` / `createMockResolver` in `packages/fetch/test/helpers/mock-resolver.ts`).
- Process spawn for the Claude CLI scorer.
- The Anthropic SDK client, via its narrow interface in `packages/worker/src/types.ts`.

**What NOT to mock:**
- The database — use real Postgres semantics via PGlite (below), never a fake DAL.
- Migrations — API tests run the real `runMigrations` against PGlite.
- `@geo/core` logic — it is pure and dependency-free; call it directly.
- Any module via `vi.mock`. If something is hard to fake, add an injectable seam to the source instead.

## Fixtures and Factories

**Database harness** — `packages/db/src/__tests__/harness.ts` exports `makePgliteDb()` returning a `DbHandle { exec, query, close }` backed by in-process WASM Postgres (`@electric-sql/pglite`, no Docker). Each call is an independent ephemeral DB, giving per-test-file isolation.

**Cross-package reuse** — `packages/api/src/__tests__/pglite-helper.ts` composes the `@geo/db` harness + executor + real migrations + real DAL rather than reimplementing:
```ts
export async function makeTestDal(): Promise<TestDal> {
  const db = await makePgliteDb();
  await runMigrations(db, MIGRATIONS_DIR);
  const dal = createAuditDal(makePgliteExecutor(db));
  return { dal, db };
}
```
Follow this when a new package needs a DB — import the harness, do not fork it.

**Network fixtures** — `packages/fetch/test/helpers/test-server.ts` (`createTestServer`) for a real loopback HTTP server, `mock-resolver.ts` for DNS.

**Location:** helpers live beside the tests that use them (`src/__tests__/*.ts` without `.test`), or `test/helpers/` for the `@geo/fetch` network fakes. No `fixtures/` directory and no static JSON fixtures — test data is constructed inline in each test.

## Real-Database Safety Gate

`packages/db/src/__tests__/harness.ts` exports `describeIfRealDb`, which resolves to `describe.skip` unless **both** `DATABASE_URL` is set **and** `ALLOW_DB_TESTS=1`. It also rejects a `DATABASE_URL` whose database-name segment does not contain `test`, `testing`, or `dev`.

`packages/db/src/__tests__/concurrency.test.ts` (WORK-01, true `SKIP LOCKED` double-claim proof) is the only consumer — it is **skipped by default** and logs why. Any test that needs real Postgres concurrency semantics must be wrapped in `describeIfRealDb`; PGlite is single-connection and cannot prove them.

## Coverage

**Requirements:** none enforced. No `coverage` config, no `@vitest/coverage-*` dependency, no threshold anywhere.

**View coverage:**
```bash
# not currently wired — requires adding the provider first
bun add -D @vitest/coverage-v8
npx vitest --coverage
```

## Test Types

**Unit tests** — the bulk. Pure-function coverage in `@geo/core` (`citability`, `robots`, `schema`, `llmstxt`, `rendering`), validators in `@geo/fetch` (`ip-validator`, `dns-resolve`, `size`, `decompression`, `redirect`).

**Integration tests** — real component wiring against in-memory Postgres: `@geo/db` (`queue`, `lifecycle`, `requeue`, `migrate`, `schema`), `@geo/api` route tests driving the real Hono app + real DAL + real migrations (`audit-post`, `audit-get`, `audits-list`, `auth`, `openapi`), `@geo/worker` `pipeline.test.ts` exercising claim → score → complete/requeue/fail against a real DAL.

**Contract/smoke tests** — `skeleton.test.ts` and `exports.test.ts` per package assert the public barrel's shape; `openapi.test.ts` asserts the generated spec.

**E2E tests** — none. No browser, no Playwright, no container-based end-to-end run.

## Common Patterns

**Async testing:**
```ts
it("returns status 200 ...", async () => {
  const result = await fetch("http://example.test/");
  expect(result.status).toBe(200);
});
```

**Error testing** — assert on the returned error *code*, not on a thrown exception, because `@geo/fetch` never throws:
```ts
const result = await fetch("http://169.254.169.254/");
expect(result.error).toBe(FetchErrorCode.SSRF_BLOCKED_IP);
expect(result.status).toBe(0);
```
For the throw-based env guards, use `expect(() => assertEnv("api")).toThrow(/ANTHROPIC_API_KEY/)` and assert the message never contains the value (`packages/worker/src/__tests__` + `packages/cron/src/__tests__/env.test.ts`).

**Env manipulation** — save, mutate, restore in-test (`packages/db/src/__tests__/harness.test.ts`):
```ts
const original = process.env["ALLOW_DB_TESTS"];
delete process.env["ALLOW_DB_TESTS"];
// ...assert...
```
Restore in a `finally`/`afterEach` so ordering stays irrelevant.

## Coverage Gaps

Modules with no dedicated `*.test.ts`:
- `packages/core/src/url.ts` and `packages/core/src/types.ts` — `normalizeUrl` is exercised indirectly through `@geo/api` route tests only.
- `packages/db/src/dal.ts` — covered indirectly via `queue`/`lifecycle`/`requeue` tests; no direct DAL contract test.
- Every `src/main.ts` (`api`, `cron`, `worker`) — process entry points and their env/wiring are untested.
- `packages/api/src/app.ts` and `packages/api/src/middleware/auth.ts` — reached only through route-level tests.
- `packages/fetch/src/errors.ts` and `packages/fetch/src/safe-requester.ts` — `safe-requester.test.ts` exists (9 cases) but `buildErrorResult` has no direct test.
- `packages/db/scripts/migrate.ts` and `packages/api/scripts/gen-docs.ts` — scripts are unrun by the suite.

Structural gaps:
- No CI — nothing enforces that the suite passes on a PR.
- No coverage instrumentation, so the gaps above are unmeasured.
- The only true-concurrency proof (`concurrency.test.ts`, WORK-01) is skipped by default; queue correctness under real parallel workers is unverified in the default run.
- The legacy Python surface (`geo/`, `scripts/`, `tests/test_fetch_page_ssr.py`) has no runner wired into the workspace.

---

*Testing analysis: 2026-07-24*
