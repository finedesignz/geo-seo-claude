---
phase: 1
slug: geo-core-deterministic-package
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-02
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | none — Wave 0 installs (`vitest.config.ts` in `packages/core/`) |
| **Quick run command** | `bun run --cwd packages/core test` |
| **Full suite command** | `bun run --cwd packages/core test -- --run` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun run --cwd packages/core test -- --run`
- **After every plan wave:** Run full suite + `bun run --cwd packages/core build`
- **Before `/gsd:verify-work`:** Full suite must be green and `build` must emit ESM+CJS+d.ts
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-00-01 | 00 | 0 | infra | — | N/A | infra | `bun run --cwd packages/core test -- --run` | ❌ W0 | ⬜ pending |
| 1-01-01 | 01 | 1 | CORE-01 | — | robots/crawlability parsed deterministically | unit | `bun run --cwd packages/core test robots` | ❌ W0 | ⬜ pending |
| 1-02-01 | 02 | 1 | CORE-02 | — | llms.txt format valid | unit | `bun run --cwd packages/core test llms` | ❌ W0 | ⬜ pending |
| 1-03-01 | 03 | 1 | CORE-03 | — | schema templates + JSON-LD extraction | unit | `bun run --cwd packages/core test schema` | ❌ W0 | ⬜ pending |
| 1-04-01 | 04 | 1 | CORE-04 | — | citability weights sum 100, sub-scores deterministic | unit | `bun run --cwd packages/core test citability` | ❌ W0 | ⬜ pending |
| 1-05-01 | 05 | 1 | CORE-05 | — | SSR/CSR classification deterministic | unit | `bun run --cwd packages/core test rendering` | ❌ W0 | ⬜ pending |
| 1-06-01 | 06 | 2 | CORE-06 | — | package importable, zero runtime deps | integration | `bun run --cwd packages/core build && node -e "require('@geo/core')"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/core/vitest.config.ts` — test config
- [ ] `packages/core/test/fixtures/` — committed sample HTML (SSR page, CSR page, page with/without JSON-LD, robots.txt samples)
- [ ] `vitest` + `tsup` + `@types/*` dev dependencies installed
- [ ] Bun workspace root `package.json` with `workspaces: ["packages/*"]`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| HOW imports `@geo/core` inline | CORE-06 / CONS-01 | HOW repo not modified this phase (deferred to Phase 7) | Verified structurally — package is workspace-linkable; full HOW wiring is Phase 7 |

*All in-repo phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
