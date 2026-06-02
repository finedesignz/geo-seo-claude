<!--
---
last_mapped_commit: 9eec32f5f700a1e6c3cb1cb735a56ee5ec49a964
refreshed: 2026-06-01
---
-->
<!-- refreshed: 2026-06-01 -->
# Architecture

**Analysis Date:** 2026-06-01

## System Overview

This is **not a conventional application** — it is a **Claude Code Skill package**. The "runtime" is Claude itself: markdown skill/agent files are prompts that instruct Claude how to orchestrate analysis, and Python scripts are deterministic tools Claude shells out to. There is no long-running server (except an optional Flask CRM UI).

```text
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code (runtime)                    │
│   User types: /geo audit <url>, /geo report <url>, etc.      │
└───────────────────────────┬─────────────────────────────────┘
                            │ reads + follows
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                Orchestrator Skill (prompt layer)             │
│                       `geo/SKILL.md`                         │
│   Command routing table + audit orchestration logic          │
└──────┬───────────────────────────────────┬──────────────────┘
       │ delegates (parallel)               │ invokes (per command)
       ▼                                    ▼
┌──────────────────────────┐   ┌───────────────────────────────┐
│   Subagents (5)          │   │   Sub-skills (15)             │
│   `agents/*.md`          │   │   `skills/geo-*/SKILL.md`     │
│   Parallel analysis      │   │   One per /geo subcommand     │
└──────────┬───────────────┘   └───────────────┬───────────────┘
           │ shell out to                       │ shell out to
           ▼                                    ▼
┌─────────────────────────────────────────────────────────────┐
│              Python tool layer (deterministic)               │
│  `scripts/fetch_page.py` `scripts/citability_scorer.py`      │
│  `scripts/brand_scanner.py` `scripts/llmstxt_generator.py`   │
│  `scripts/crm_dashboard.py` `scripts/webapp/app.py`          │
└──────────┬──────────────────────────────────┬───────────────┘
           │ reads                              │ writes
           ▼                                    ▼
┌──────────────────────────┐   ┌───────────────────────────────┐
│  Static assets            │   │  User data store              │
│  `schema/*.json`          │   │  `~/.geo-prospects/`          │
│  `templates/*.html,.css`  │   │  prospects.json, audits/,     │
│                           │   │  proposals/                   │
└──────────────────────────┘   └───────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Orchestrator skill | Command routing, audit phase orchestration, score synthesis | `geo/SKILL.md` |
| Sub-skills (15) | Per-command instructions (audit, citability, schema, report, etc.) | `skills/geo-*/SKILL.md` |
| Subagents (5) | Parallel analysis personas spawned during full audit | `agents/*.md` |
| Page fetcher | HTTP fetch + HTML/meta/structured-data parse, AI-crawler UA tests | `scripts/fetch_page.py` |
| Citability scorer | Score passages 0-100 for AI citation readiness | `scripts/citability_scorer.py` |
| Brand scanner | Detect brand mentions across AI-cited platforms | `scripts/brand_scanner.py` |
| llms.txt tool | Validate / generate `llms.txt` | `scripts/llmstxt_generator.py` |
| CRM dashboard (CLI) | Rich-rendered prospect pipeline view | `scripts/crm_dashboard.py` |
| CRM web UI | Flask + HTMX prospect/proposal browser | `scripts/webapp/app.py` |
| JSON-LD templates | Schema markup boilerplate by business type | `schema/*.json` |
| Report templates | HTML/CSS for client-ready GEO reports | `templates/geo-report-*` |
| White-label config | Agency branding overrides | `white-label/brand_config.py` |

## Pattern Overview

**Overall:** Prompt-orchestrated tool pipeline (LLM-as-orchestrator + deterministic CLI tools). Mirrors the WAT pattern: probabilistic agents reason, deterministic scripts execute.

**Key Characteristics:**
- Markdown files (`SKILL.md`, `agents/*.md`) are the control flow — they are prompts, not code.
- Python scripts are pure stdin/argv → stdout-JSON tools, stateless and independently runnable.
- Fan-out/fan-in: full audit spawns 5 subagents in parallel, then synthesizes one composite GEO Score (0-100).
- No framework, no DI, no class hierarchy — flat scripts + flat skill tree.

## Layers

**Prompt / orchestration layer:**
- Purpose: route commands and drive multi-phase audit
- Location: `geo/SKILL.md`, `skills/geo-*/SKILL.md`, `agents/*.md`
- Contains: markdown instructions, command tables, orchestration phases
- Depends on: Claude's tool capabilities (Read, Grep, Glob, Bash, WebFetch, Write)
- Used by: Claude Code at invocation time

**Tool layer:**
- Purpose: deterministic fetching, scoring, generation, persistence
- Location: `scripts/*.py`, `scripts/webapp/`
- Contains: standalone Python CLIs (argparse / argv / stdin), Flask app
- Depends on: `requirements.txt` libs (requests, beautifulsoup4, lxml, playwright, Pillow, flask, rich, validators)
- Used by: skills/agents via Bash; users directly via CLI

**Asset layer:**
- Purpose: reusable static inputs and report scaffolding
- Location: `schema/*.json`, `templates/`, `white-label/brand.example.json`
- Used by: schema/report sub-skills and the PDF/HTML report generators

**Data layer (user-local):**
- Purpose: CRM persistence
- Location: `~/.geo-prospects/` (`prospects.json`, `audits/`, `proposals/`)
- Accessed by: `scripts/webapp/app.py`, `scripts/crm_dashboard.py`, the prospect/proposal/compare skills

## Data Flow

### Primary Request Path — Full Audit (`/geo audit <url>`)

1. User invokes `/geo audit <url>` → Claude loads `geo/SKILL.md` (`geo/SKILL.md`)
2. **Discovery (sequential):** fetch homepage, detect business type, crawl sitemap via `scripts/fetch_page.py`
3. **Parallel analysis:** spawn 5 subagents — `agents/geo-ai-visibility.md`, `agents/geo-platform-analysis.md`, `agents/geo-technical.md`, `agents/geo-content.md`, `agents/geo-schema.md`
4. Each subagent shells out to `scripts/*.py` (e.g. `scripts/citability_scorer.py`, `scripts/brand_scanner.py`) returning JSON
5. **Synthesis:** orchestrator aggregates sub-scores into a composite GEO Score (0-100) per `docs/scoring-methodology.md`
6. **Output:** report rendered via `templates/geo-report-template.html` / PDF (`skills/geo-report-pdf/SKILL.md`)

### CRM / Sales Flow (`/geo prospect`, `/geo proposal`, `/geo compare`)

1. Audit results persisted to `~/.geo-prospects/audits/`
2. Prospect records managed in `~/.geo-prospects/prospects.json` (`scripts/webapp/app.py` load/save helpers)
3. Proposals generated to `~/.geo-prospects/proposals/`
4. Viewed via CLI (`scripts/crm_dashboard.py`) or Flask web UI on `localhost:5050` (`scripts/webapp/app.py`)

**State Management:**
- All persistent state is user-local JSON under `~/.geo-prospects/`. No database. Scripts are otherwise stateless.

## Key Abstractions

**Skill (`SKILL.md`):**
- Purpose: a self-contained command definition with YAML frontmatter (`name`, `description`, `allowed-tools`)
- Examples: `geo/SKILL.md`, `skills/geo-audit/SKILL.md`
- Pattern: one directory per command; frontmatter declares allowed tools

**Subagent (`agents/*.md`):**
- Purpose: a focused analysis persona invoked in parallel during audit
- Examples: `agents/geo-technical.md`, `agents/geo-content.md`
- Pattern: 5 fixed agents matching the 5 audit dimensions

**Tool script:**
- Purpose: deterministic, independently testable CLI returning JSON
- Examples: `scripts/fetch_page.py` (`fetch_page(url) -> dict`), `scripts/citability_scorer.py` (`score_passage(text) -> dict`)
- Pattern: top-level `try/except ImportError` guard pointing to `requirements.txt`; argv/stdin in, JSON out

## Entry Points

**Skill invocation:**
- Location: `geo/SKILL.md` (installed to `~/.claude/skills/geo/`)
- Triggers: `/geo <command> <url>` in Claude Code, or keyword match ("geo", "seo", "audit", "citability", …)
- Responsibilities: route to sub-skill / orchestrate audit

**Installer:**
- Location: `install.sh`, `install-win.sh`
- Triggers: one-command curl-pipe or local run
- Responsibilities: clone repo into `~/.claude/skills/geo/`, create isolated `.venv`, patch `.md` python paths to `~/.claude/skills/geo/.venv/bin/python3`

**CLI tools:**
- Location: `scripts/*.py` — each runnable as `python <script>.py`

**Web UI:**
- Location: `scripts/webapp/app.py` — `python app.py` → `http://localhost:5050`

## Architectural Constraints

- **Runtime is Claude:** control flow lives in markdown prompts, not executable code. Changing behavior often means editing `SKILL.md`, not Python.
- **Isolated venv:** installer pins all Python deps in `~/.claude/skills/geo/.venv`; `.md` files reference that absolute interpreter path. Do not assume system Python.
- **No shared global state in scripts:** each script is stateless; the only cross-invocation state is `~/.geo-prospects/` JSON files.
- **Path tilde literalness:** `install.sh` intentionally keeps `~/.claude/...` literal in patched `.md` references (Claude's Bash expands it later) — see comment in `install.sh`. Do not pre-expand to `$HOME`.
- **Single-threaded scripts:** parallelism happens at the Claude subagent level, not inside Python.

## Anti-Patterns

### Putting analysis logic in Python instead of skills
**What happens:** logic that should be Claude reasoning (scoring narrative, recommendations) gets hard-coded in a script.
**Why it's wrong:** the design splits probabilistic reasoning (skills/agents) from deterministic computation (scripts). Burying judgment in Python makes it rigid and un-tunable.
**Do this instead:** keep scripts to fetch/parse/score primitives (see `scripts/citability_scorer.py`), and let `skills/*/SKILL.md` own interpretation.

### Hard-coding the Python interpreter path
**What happens:** a new `.md` references `python3` or a system path instead of the patched venv path.
**Why it's wrong:** breaks on installed systems where deps live only in `~/.claude/skills/geo/.venv`.
**Do this instead:** reference `~/.claude/skills/geo/.venv/bin/python3` as the installer patches (`install.sh`).

### Writing CRM state outside `~/.geo-prospects/`
**What happens:** a script invents its own data location.
**Why it's wrong:** the CLI dashboard and Flask UI both read fixed paths (`scripts/webapp/app.py` `CRM_PATH`, `PROPOSALS_DIR`, `AUDITS_DIR`).
**Do this instead:** route all prospect/audit/proposal persistence through `~/.geo-prospects/`.

## Error Handling

**Strategy:** fail-fast with user-actionable messages.

**Patterns:**
- Import guards: `try: import requests... except ImportError: print("Run: pip install -r requirements.txt"); sys.exit(1)` (`scripts/fetch_page.py`, `scripts/citability_scorer.py`)
- Per-result `errors` list collected into the returned dict rather than raising (`fetch_page` result schema)
- Flask `abort()` for missing CRM resources (`scripts/webapp/app.py`)

## Cross-Cutting Concerns

**Logging:** none structured; scripts print to stdout/stderr. `rich` used for CLI presentation (`scripts/crm_dashboard.py`).
**Validation:** `validators` lib for URLs; BeautifulSoup/lxml for HTML parse robustness.
**Branding:** white-label overrides via `white-label/brand_config.py` + `white-label/brand.example.json`.

---

*Architecture analysis: 2026-06-01*
