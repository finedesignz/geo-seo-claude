# Phase 6 — Validation Map (Nyquist)

**Phase:** 06-Containerize & Coolify Deploy
**Created:** 2026-06-04

Every must-have has an automated gate where possible; live-only items are explicitly marked DEFERRED-LIVE (depend on the human gate, validated in plan 03).

## Source Coverage Audit

| Source | Item | Covered by |
|--------|------|------------|
| GOAL (ROADMAP) | API+worker ship as image on Coolify, secrets from env, verified by live /healthz + audit round-trip | 06-01 (image), 06-02 (verify/runbook), 06-03 (live) |
| REQ | DEPLOY-01 (one image, API\|worker by command) | 06-01 |
| REQ | DEPLOY-03 (migrations on deploy, secrets from env) | 06-01 (.env.example, .dockerignore), 06-02 (runbook migrate) |
| REQ | DEPLOY-04 (live /healthz + audit round-trip, not /health alone) | 06-02 (script), 06-03 (live run) |
| REQ | DEPLOY-02 | DEFERRED — cron logic is Phase 7; only image/command pattern proven here (CONTEXT in-scope note) |
| RESEARCH | multi-stage Dockerfile, pglite prune, PID-1/tini, heartbeat | 06-01 |
| RESEARCH | deploy-verify field names (Q6), DEDUP_TTL not env (Q5) | resolved in planning; folded into 06-01/06-02 interfaces |
| CONTEXT | D-01..D-09 | D-01/02/03/04 → 06-01; D-05/07 → 06-01+06-02; D-06 → 06-01; D-08 → 06-02+06-03; D-09 → 06-02 runbook + 06-03 verify |
| CONTEXT | Human Gate (4 operator items) | 06-03 checkpoint + 06-02 runbook |

No unplanned items. Exclusions: DEPLOY-02 cron logic, CONS-01/02, CI/CD, runtime trimming — all CONTEXT-deferred to Phase 7 / out of v1.

## Must-Have → Gate

| Must-have | Gate | Automated | Plan |
|-----------|------|-----------|------|
| Single multi-stage Dockerfile, default CMD = API | grep Dockerfile + `docker build` (or deferred-note if docker absent) | yes (build conditional) | 06-01 T1 |
| No secret in image / .env excluded | grep .dockerignore; grep .env.example has no real token | yes | 06-01 T1/T3 |
| Worker heartbeat each loop | grep worker.ts + `bun --filter @geo/worker build && test` | yes | 06-01 T2 |
| .env.example covers all 14 code-read vars; no DEDUP_TTL | per-var grep loop + DEDUP_TTL-absent assert | yes | 06-01 T3 |
| Verify script: healthz→docs→401→audit round-trip, env-driven | `bash -n` + grep + no-hardcoded-token gate | yes (syntax); DEFERRED-LIVE (run) | 06-02 T1 / 06-03 |
| Deploy runbook complete (operator vs automatable split) | section-keyword grep | yes | 06-02 T2 |
| Live deploy + smoke pass (DEPLOY-04, success #2/#4) | deploy-verify.sh against live URL; worker stop-grace ≥ SHUTDOWN_GRACE_MS | **DEFERRED-LIVE** (human gate) | 06-03 |

## Deferred / Live-only items

- **Live Coolify deploy + smoke** (06-03): depends on the operator Human Gate (provision app+Postgres, enter secrets, wire 2 resources, set stop grace). If the gate is unmet at execution, 06-03 records a clean deferral → live DEPLOY-04 becomes a Phase-7 precondition. The phase is NOT blocked on it.
- **`docker build` locally** (06-01): runs only if docker is available in the executor env; otherwise the executor notes the deferral and the build is validated by Coolify in 06-03.
