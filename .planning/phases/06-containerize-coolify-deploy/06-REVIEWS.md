# Phase 6 — Cross-AI PLAN Review

**Reviewed:** 2026-06-04 (pre-execution PLAN review)
**Reviewers:** gemini-2.5-pro ✓ · codex ✗ (auth token expired — `refresh token already used`, needs interactive re-login; skipped) · claude self-skipped (`CLAUDE_CODE_ENTRYPOINT=cli`)

## Disposition summary

| # | Sev | Issue | Disposition |
|---|-----|-------|-------------|
| 1 | HIGH | Dockerfile runtime stage omits a filesystem `docs/` dir → claims `/docs` (rule 21 / API-06) breaks | **REJECTED (false positive, evidence-backed)** |
| 2 | MEDIUM | `.dockerignore` `*.md` pattern ambiguous; plan defers to research instead of pinning exact content | **FOLD** into 06-01 |

### #1 — REJECTED with evidence
Gemini assumed `/docs` is served from a filesystem `docs/` directory that the slim runtime stage fails to copy. **This is false.** Verified in Phase 5 code:
- `packages/api/src/app.ts:79` — `app.get("/docs", Scalar({ url: "/openapi.json", theme: "default" }))` serves the Scalar UI **in-code** from the in-memory OpenAPI document.
- `packages/api/src/app.ts:73` — `app.doc31("/openapi.json", …)` generates the spec **in-code** from the registered zod-openapi routes.
- Grep confirms **nothing** under `packages/api/src` reads a filesystem `docs/` dir, `api.md`, or uses `fs.readFile`/`readdir` at runtime.
- `docs/api.md` (rule 21) is a **committed repo artifact** (build-time generated, committed), not served at runtime.

→ The slim runtime image needs **no** `docs/` directory for `/docs` + `/openapi.json` to work. No Dockerfile change. (Note for executor: confirm the build keeps `@scalar/hono-api-reference` in the production dependency tree — it is a runtime dep of the API, must survive `--production` prune. This is the only real risk in the vicinity of #1 and is already covered by 06-01's "prod prune keeps runtime deps" acceptance.)

### #2 — FOLD into 06-01
Pin the exact `.dockerignore` contents in the plan rather than deferring to the (ambiguous) research snippet. Required exclusions: `.git`, `.env`, `.env.*` (keep `!.env.example`), `.planning`, `node_modules` (build installs fresh), `**/*.test.ts`/`**/__tests__`, `**/dist` (built inside image), editor/OS cruft. Do **not** use a blanket `*.md`/`**/*.md` that could drop files the build needs; markdown is irrelevant to the runtime so simplest-correct is to exclude `.planning` + docs noise explicitly and leave package sources intact. Add a one-line acceptance: `docker build` context excludes any secret (`.env*` except `.env.example`).

## Verdict
**SHIP-PLAN** — one HIGH refuted with code evidence, one MEDIUM folded into 06-01 (executor brief). No human decision required.
