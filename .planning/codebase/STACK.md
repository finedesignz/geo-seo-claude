# Technology Stack

**Analysis Date:** 2026-07-24

## Languages

**Primary:**
- TypeScript 6.0.3 — all six workspace packages under `packages/*/src` (`packages/core`, `packages/fetch`, `packages/db`, `packages/api`, `packages/worker`, `packages/cron`). ESM only (`"type": "module"` in every package manifest).
- SQL — schema migrations in `packages/db/migrations/0001_create_audits.sql`, `packages/db/migrations/0002_add_consumer_id.sql`.

**Secondary:**
- Python 3 — the standalone skill tooling in `scripts/`: `scripts/brand_scanner.py`, `scripts/citability_scorer.py`, `scripts/fetch_page.py`, `scripts/llmstxt_generator.py`, `scripts/crm_dashboard.py`, and the Flask app `scripts/webapp/app.py` + `scripts/webapp/templates/`. Not part of the Bun workspace or the Docker runtime path.
- Shell (POSIX sh/bash) — `scripts/docker-entrypoint.sh`, `scripts/worker-healthcheck.sh`, `scripts/deploy-verify.sh`, `install.sh`, `install-win.sh`, `uninstall.sh`.
- Markdown — the Claude skill/agent surface: `geo/SKILL.md`, `agents/geo-ai-visibility.md`, `agents/geo-content.md`, `agents/geo-platform-analysis.md`, `agents/geo-schema.md`, `agents/geo-technical.md`.

## Runtime

**Environment:**
- Bun 1.3.1 — pinned exactly in `Dockerfile:20` and `Dockerfile:52` (`oven/bun:1.3.1-slim`, never `:latest`). Bun is PID 1 via exec-form dispatch in `scripts/docker-entrypoint.sh`.
- Node.js 22 — installed in the runtime stage (`Dockerfile:65-66`) solely to host the globally installed Claude Code CLI. Application code does not run on Node.
- Python 3 — required only for `scripts/*.py` and `scripts/webapp/app.py`.

**Package Manager:**
- Bun workspaces. Root `package.json` declares `"workspaces": ["packages/*", "examples"]` and is `private`.
- Lockfile: `bun.lock` present; installs are `--frozen-lockfile` in both Docker stages (`Dockerfile:33`, `Dockerfile:80`).
- pip for the Python side: `requirements.txt`.

## Frameworks

**Core:**
- Hono 4.12.23 — HTTP server for `@geo/api` (`packages/api/src/app.ts`, `packages/api/src/main.ts`).
- `@hono/zod-openapi` 0.19.10 — typed routes plus generated `/openapi.json`.
- `@scalar/hono-api-reference` 0.10.20 — serves `/docs`. Both are runtime deps kept through the production prune (`Dockerfile:73-75`).
- Zod 3.25.51 — request/response and scorer-output schemas (`@geo/api`, `@geo/worker`).

**Testing:**
- Vitest 4.1.8 — dev dep and `test` script in all six packages; suites live in `packages/*/src/__tests__/`.
- `@electric-sql/pglite` 0.5.1 — in-process Postgres for DB-touching tests (dev dep of `@geo/api`, `@geo/db`, `@geo/worker`, `@geo/cron`). Gated by `ALLOW_DB_TESTS`.

**Build/Dev:**
- tsup 8.5.1 — every package's `build` script; emits `dist/index.js` + `dist/index.cjs` + `.d.ts`, plus `dist/main.js` entrypoints for `@geo/api`, `@geo/worker`, `@geo/cron`.
- TypeScript 6.0.3 — dev dep in all packages.

## Key Dependencies

**Critical:**
- `@anthropic-ai/sdk` 0.100.1 (`packages/worker`) — API scoring path (`packages/worker/src/scorer.ts`).
- `@anthropic-ai/claude-code` (npm global; version via `ARG CLAUDE_CODE_VERSION`, default `latest` — `Dockerfile:56`, `Dockerfile:67`) — subscription scoring path spawned by `packages/worker/src/cli-scorer.ts`.
- `postgres` 3.4.9 (`packages/db`) — the only Postgres driver; pool configured in `packages/db/src/client.ts:35` with `max: 10`.
- `undici` 8.3.0 (`packages/fetch`) — HTTP client under the SSRF-safe fetcher.
- `ipaddr.js` 2.4.0 (`packages/fetch`) — IP classification for `packages/fetch/src/ip-validator.ts`.

**Infrastructure:**
- Internal deps wired as `workspace:*`: `@geo/core` (leaf), `@geo/fetch`, `@geo/db`, consumed by `@geo/api`, `@geo/worker`, `@geo/cron`.

**Python (`requirements.txt`):**
- `beautifulsoup4>=4.12`, `lxml>=6.0.2`, `requests>=2.32.4`, `urllib3>=2.6.3`, `validators>=0.22`, `playwright>=1.56`, `Pillow>=12.1`, `flask>=3.0`, `rich>=13.0`.

## Configuration

**Environment:**
- All configuration is env-var driven; `.env.example` documents the contract and `.dockerignore` drops `.env*` so nothing is baked into the image (`Dockerfile:15`).
- Env vars referenced in code: `GEO_ROLE`, `PORT`, `DATABASE_URL`, `GEO_API_KEYS`, `SCORING_PROVIDER`, `SCORING_MODEL`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_BIN`, `WORKER_HEARTBEAT_FILE`, `CRON_TARGET_URLS`, `CRON_API_TOKEN`, `GEO_API_BASE_URL`, `ALLOW_DB_TESTS`.
- Validation is fail-fast at startup: `packages/worker/src/env.ts`, `packages/cron/src/env.ts` (required trio at `packages/cron/src/env.ts:61`), `packages/api/src/middleware/auth.ts:48` (refuses to boot without `GEO_API_KEYS`).
- Defaults in code: `SCORING_MODEL` defaults to `claude-sonnet-4-6` (`packages/worker/src/main.ts:49`); `SCORING_PROVIDER` auto-selects `api` when `ANTHROPIC_API_KEY` is set, else `cli` (`packages/worker/src/env.ts:33`).

**Build:**
- `Dockerfile` — three stages (`deps` → `build` → `runtime`); dev deps are pruned only in the runtime stage (`Dockerfile:80`).
- Per-package `tsup` config drives each `build` script.
- `.dockerignore` controls build context.

## Platform Requirements

**Development:**
- Bun 1.3.x, a reachable Postgres for `DATABASE_URL` (pglite covers tests), and optionally the `claude` CLI on PATH for CLI scoring (`CLAUDE_BIN` overrides the binary path).
- Python 3 + `requirements.txt` only when working on `scripts/`.

**Production:**
- Single Docker image, three roles selected by `GEO_ROLE` in `scripts/docker-entrypoint.sh:17-21`: `api` (default, `EXPOSE 8080`), `worker` (no port, SIGTERM drain bounded by `SHUTDOWN_GRACE_MS`), `cron` (one-shot). Migrations run pre-deploy via `bun packages/db/scripts/migrate.ts` (advisory-locked, idempotent).
- Runs non-root as the image's `bun` user (`Dockerfile:83`); `STOPSIGNAL SIGTERM`.
- Deployed on Coolify; health checks are configured per-resource, not in the image (`Dockerfile:90-92`), with `curl`/`wget` installed for in-container probes.
- No CI pipeline: there is no `.github/` directory in the repo.

---

*Stack analysis: 2026-07-24*
