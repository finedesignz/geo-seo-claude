# Codebase Structure

**Analysis Date:** 2026-07-24

## Directory Layout

```
geo-seo-claude/
├── packages/               # Bun workspace — the deployable TypeScript service
│   ├── core/               # @geo/core — pure deterministic GEO checks
│   ├── fetch/              # @geo/fetch — SSRF-safe HTTP + decompression
│   ├── db/                 # @geo/db — Postgres DAL, queue, migrations
│   ├── api/                # @geo/api — Bun.serve + OpenAPIHono HTTP surface
│   ├── worker/             # @geo/worker — queue consumer + scoring
│   └── cron/               # @geo/cron — one-shot scheduled re-audit batch
├── geo/                    # SKILL.md — the Claude Code skill entry point
├── skills/                 # 15 geo-* subskills (Markdown SOPs)
├── agents/                 # 5 subagent definitions (Markdown)
├── schema/                 # JSON-LD schema templates (6 types)
├── templates/              # HTML + CSS report templates
├── white-label/            # Brand config for rebranded reports
├── scripts/                # Python analysis helpers + ops shell scripts
│   └── webapp/             # Flask-style CRM dashboard + templates
├── examples/               # Workspace member — sample outputs + inline-usage test
├── tests/                  # Python/manual test artifacts
├── docs/                   # Published docs (architecture, deploy, methodology)
├── assets/
├── Dockerfile              # Single multi-stage image, role via GEO_ROLE
├── package.json            # Root workspace manifest (private, no scripts)
└── bun.lock
```

## Directory Purposes

**`packages/core`:**
- Purpose: pure GEO analysis — no I/O except an injected `Fetcher`.
- Key files: `src/citability.ts`, `src/robots.ts`, `src/rendering.ts`,
  `src/schema.ts`, `src/llmstxt.ts`, `src/url.ts`, `src/types.ts`.
- Also holds `fixtures/` for deterministic check tests.

**`packages/fetch`:**
- Purpose: hardened outbound HTTP.
- Key files: `src/safe-fetcher.ts` (GET, 485 lines), `src/safe-requester.ts` (POST),
  `src/decompression.ts`, `src/dns-resolve.ts`, `src/ip-validator.ts`, `src/errors.ts`.
- `test/helpers/` holds network fixtures separate from `src/__tests__/`.

**`packages/db`:**
- Purpose: persistence + queue semantics.
- Key files: `src/dal.ts` (`createAuditDal`, `makePgExecutor`, `getDefaultDal`),
  `src/client.ts`, `src/migrate.ts`, `src/types.ts`.
- `migrations/` holds numbered SQL (`0001_create_audits.sql`,
  `0002_add_consumer_id.sql`); `scripts/migrate.ts` is the runnable entry.

**`packages/api`:**
- Purpose: HTTP contract.
- Key files: `src/app.ts` (factory), `src/main.ts` (Bun.serve entry),
  `src/middleware/auth.ts`, `src/routes/{audit-post,audit-get,audits-list,healthz}.ts`.

**`packages/worker`:**
- Purpose: consume the queue and produce scores.
- Key files: `src/worker.ts` (loop), `src/pipeline.ts` (`runAudit`),
  `src/scorer.ts` (API provider), `src/cli-scorer.ts` (Claude Code CLI provider),
  `src/webhook.ts`, `src/env.ts`, `src/main.ts`.

**`packages/cron`:**
- Purpose: scheduled re-audit batch.
- Key files: `src/cron.ts`, `src/env.ts`, `src/main.ts`.

**`geo/`, `skills/`, `agents/`:**
- Purpose: the Claude Code skill surface. `geo/SKILL.md` is the single declared
  skill (frontmatter `name: geo`); it routes to `skills/geo-<capability>/` SOPs and
  `agents/geo-*.md` subagents. Markdown only — no executable code.

**`schema/`, `templates/`, `white-label/`:**
- Purpose: output assets. `schema/*.json` are JSON-LD starting points
  (`local-business`, `organization`, `article-author`, `product-ecommerce`,
  `software-saas`, `website-searchaction`); `templates/geo-report-template.html` +
  `geo-report-style.css` render client reports; `white-label/brand_config.py` +
  `brand.example.json` swap branding.

**`scripts/`:**
- Purpose: two unrelated groups. Python helpers used by the skill
  (`citability_scorer.py`, `brand_scanner.py`, `fetch_page.py`,
  `llmstxt_generator.py`, `crm_dashboard.py` + `webapp/`) and ops shell scripts for
  the container (`docker-entrypoint.sh`, `worker-healthcheck.sh`, `deploy-verify.sh`).

## Key File Locations

**Entry Points:**
- `packages/api/src/main.ts`: HTTP server (PORT default 8080).
- `packages/worker/src/main.ts`: long-lived worker.
- `packages/cron/src/main.ts`: one-shot cron.
- `packages/db/scripts/migrate.ts`: migration runner.
- `scripts/docker-entrypoint.sh`: `GEO_ROLE` dispatch to the above.
- `geo/SKILL.md`: Claude Code skill.

**Configuration:**
- `package.json`: root workspace (`packages/*`, `examples`).
- `packages/*/package.json`: per-package tsup build + vitest scripts.
- `Dockerfile`: pinned `oven/bun:1.3.1-slim`, deps/build/runtime stages.
- `examples/vitest.config.ts`.

**Core Logic:**
- `packages/worker/src/pipeline.ts`: the audit orchestration.
- `packages/db/src/dal.ts`: queue semantics.
- `packages/fetch/src/safe-fetcher.ts`: the security boundary.

**Testing:**
- `packages/<pkg>/src/__tests__/*.test.ts` (co-located per package).
- `packages/db/src/__tests__/harness.ts` + `pglite-executor.ts`: PGlite harness.
- `packages/api/src/__tests__/pglite-helper.ts`.

## Naming Conventions

**Files:**
- kebab-case TypeScript modules: `safe-fetcher.ts`, `audit-post.ts`, `cli-scorer.ts`.
- Tests mirror the module name: `<module>.test.ts` in `__tests__/`.
- Migrations: `NNNN_snake_case_description.sql`.
- Skill dirs: `geo-<capability>/`; agent files: `geo-<domain>.md`.
- Python helpers: `snake_case.py`.

**Directories:**
- Packages are bare capability names (`core`, `fetch`, `db`) published as `@geo/<name>`.
- Each package: `src/`, `src/__tests__/`, `dist/` (built, gitignored), optional
  `scripts/`, `fixtures/`, `migrations/`.

## Where to Add New Code

**New deterministic GEO check:**
- Implementation: `packages/core/src/<check>.ts`, re-exported from
  `packages/core/src/index.ts`.
- Fixtures: `packages/core/fixtures/`.
- Tests: `packages/core/src/__tests__/<check>.test.ts`.
- Wire into `packages/worker/src/pipeline.ts` and extend `FindingsShape` in
  `packages/db/src/types.ts`.

**New API endpoint:**
- Route module: `packages/api/src/routes/<verb-noun>.ts` exporting
  `register<Name>(app, deps)`.
- Register it in `packages/api/src/app.ts` so it lands in the OpenAPI registry.
- Tests: `packages/api/src/__tests__/<verb-noun>.test.ts` using the PGlite helper.

**Schema change:**
- New numbered SQL in `packages/db/migrations/` (never edit an applied file).
- Update `packages/db/src/types.ts` and the affected `dal.ts` queries.
- Tests: `packages/db/src/__tests__/schema.test.ts`.

**New scoring provider:**
- `packages/worker/src/<name>-scorer.ts` returning the same `.score()` shape as
  `createScorer`; add the branch in `resolveScoringProvider`
  (`packages/worker/src/env.ts`) and the wiring in `packages/worker/src/main.ts`.

**New container role:**
- New package under `packages/` emitting `dist/main.js`, a build line in the
  `Dockerfile` build stage, and a `case` branch in `scripts/docker-entrypoint.sh`.

**New skill capability:**
- `skills/geo-<capability>/SKILL.md`, referenced from `geo/SKILL.md`; any
  deterministic helper goes in `scripts/<name>.py`.

**Shared helpers:**
- Cross-package pure utilities belong in `packages/core/src/`; HTTP-adjacent
  helpers in `packages/fetch/src/`. There is no `utils/` catch-all — do not add one.

## Special Directories

**`packages/*/dist/`:**
- Purpose: tsup output (`main.js` per package), consumed by the Docker runtime stage.
- Generated: Yes. Committed: No.

**`examples/`:**
- Purpose: a real workspace member holding sample outputs (audit JSON, proposal MD,
  a generated PDF) plus `how-inline-usage.ts` and its test. Contains
  `__pycache__/` from the Python client.
- Generated: Partly. Committed: Yes.

**`tests/`:**
- Purpose: Python/manual artifacts (`test_fetch_page_ssr.py`,
  `agent-readiness-test-results.md`). NOT the TypeScript test location — those are
  co-located under each package.

**`docs/`:**
- Purpose: published docs contract (`architecture.md`, `deploy.md`, `consumers.md`,
  `scoring-methodology.md`, `commands-reference.md`, `skills-and-agents.md`).
- Committed: Yes; keep in sync when behavior changes.

---

*Structure analysis: 2026-07-24*
