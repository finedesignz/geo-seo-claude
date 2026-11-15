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
  Claude Code CLI scorer).
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

- **LLM auth is subscription OAuth only (rule 22c).** The former `SCORING_PROVIDER=api`
  / `ANTHROPIC_API_KEY` scoring mode was removed. `@geo/worker` scores only via the
  Claude Code CLI (`CLAUDE_CODE_OAUTH_TOKEN`); `SCORING_PROVIDER` is optional and any
  value other than `cli` fails at startup. `cli-scorer.ts` still strips `ANTHROPIC_API_KEY`
  from the child env.
- README/install scripts (`install.sh`, `install-win.sh`) still reference the
  upstream fork URL (`zubair-trabzada/geo-seo-claude`), not
  `finedesignz/geo-seo-claude` -- stale branding from the fork point, not a
  functional bug, but worth fixing if this repo is customized further.
