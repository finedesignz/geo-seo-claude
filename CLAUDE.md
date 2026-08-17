<!-- template-version: 1 -->
<!-- repo-align-template: dev v1 -->

# CLAUDE.md

## Purpose

geo-seo-claude is a GEO (Generative Engine Optimization) toolkit that
optimizes websites for AI-powered search engines (ChatGPT, Claude,
Perplexity, Gemini, Google AI Overviews) alongside traditional SEO. This is
`finedesignz/geo-seo-claude`, a fork of `zubair-trabzada/geo-seo-claude` --
we own this fork (write access confirmed) and it is in scope for this align
pass, unlike a bare upstream checkout with no fork remote.

## Stack

- Bun workspaces monorepo (`workspaces: ["packages/*", "examples"]`).
- Packages: `@geo/api` (Hono + `@hono/zod-openapi` + Scalar, HTTP API),
  `@geo/core` (shared types/logic), `@geo/cron` (scheduled scoring jobs),
  `@geo/db` (Postgres via `postgres`/porsager, `tsup`-built), `@geo/fetch`
  (HTTP fetching, `undici` + `ipaddr.js`), `@geo/worker` (scoring worker,
  `@anthropic-ai/sdk`).
- `tsup` build, `vitest` test, across every package.
- `@electric-sql/pglite` as an in-memory Postgres for tests/dev in several
  packages.

## Commands

```bash
# install
bun install

# test (all workspaces, sequential)
bun run --sequential --filter='*' test -- --run

# per-package build
bun run --filter=@geo/<pkg> build

# per-package test
bun run --filter=@geo/<pkg> test

# db migrations (packages/db)
bun scripts/migrate.ts
bun scripts/migrate.ts status
```

## Deploy target

Coolify, single multi-stage Docker image for the whole Bun workspace. Role
selected at runtime by the `GEO_ROLE` env var (`scripts/docker-entrypoint.sh`):
`GEO_ROLE=api` (default, `bun packages/api/dist/main.js`, `PORT` 8080),
`GEO_ROLE=worker` (`bun packages/worker/dist/main.js`, no port, SIGTERM
drain), `GEO_ROLE=cron` (`bun packages/cron/dist/main.js`, one-shot, Coolify
scheduled task). Migration runs pre-deploy
(`bun packages/db/scripts/migrate.ts`, advisory-locked, idempotent). This
role-via-env-var design exists specifically because Coolify's Dockerfile
build pack does not honor per-resource start-command overrides (verified
4.1.1). Base image is pinned to an exact `oven/bun` patch tag, never
`:latest`. Secrets are never baked in -- injected via Coolify env,
`.dockerignore` drops `.env*`.

## Repo conventions

- Workspace package naming: `@geo/<name>`, cross-package deps declared as
  `workspace:*`.
- Each package builds independently via `tsup`, tests via `vitest`.

## GSD state

No `.planning/` directory present -- not currently GSD-tracked.

## Gotchas

- **LLM API-key handling is a REAL, LIVE, DUAL-MODE design -- and one of the
  two modes is a genuine rule 22c violation when selected. This needs an
  actual fix, not just documentation, flag it for follow-up.**
  `packages/worker/src/env.ts` implements `SCORING_PROVIDER` with two modes:
  - `"cli"` -- uses `CLAUDE_CODE_OAUTH_TOKEN` (subscription, compliant).
  - `"api"` -- uses `ANTHROPIC_API_KEY` directly against the Anthropic
    Messages API (`packages/worker/src/main.ts:70`,
    `packages/worker/src/scorer.ts:10`). **This is a real rule 22c
    violation when this mode is active** -- it is not a test-only fake, not
    an avoided path; it is a fully implemented, documented, supported
    production code path.
  - **Worse: the default is not "cli."** `resolveScoringProvider()`
    (`env.ts:25-34`) auto-selects `"api"` whenever `ANTHROPIC_API_KEY`
    happens to be present in the environment, with no explicit
    `SCORING_PROVIDER` set. A container that merely has that env var set for
    some unrelated reason will silently switch to API-key auth.
  - The comments here are about not *committing* a real key ("Never commit a
    real API key") -- they are NOT a statement that the API-key path itself
    is disallowed. Do not mistake this for the compliant-by-design pattern
    seen in agentautofix/aiadshq-app; this repo needs the `"api"` mode
    either removed or the default flipped to always require an explicit,
    audited opt-in, with `"cli"` as the unconditional default.
- README/install scripts (`install.sh`, `install-win.sh`) still reference the
  upstream fork URL (`zubair-trabzada/geo-seo-claude`), not
  `finedesignz/geo-seo-claude` -- stale branding from the fork point, not a
  functional bug, but worth fixing if this repo is customized further.
