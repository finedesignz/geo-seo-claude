<!--
---
last_mapped_commit: 9eec32f5f700a1e6c3cb1cb735a56ee5ec49a964
refreshed: 2026-06-01
---
-->
# Codebase Structure

**Analysis Date:** 2026-06-01

## Directory Layout

```text
geo-seo-claude/
├── geo/                       # Orchestrator skill (entry point)
│   └── SKILL.md               # Command routing + audit orchestration
├── skills/                    # 15 specialized sub-skills (one dir per command)
│   ├── geo-audit/SKILL.md
│   ├── geo-citability/SKILL.md
│   ├── geo-brand-mentions/SKILL.md
│   ├── geo-crawlers/SKILL.md
│   ├── geo-llmstxt/SKILL.md
│   ├── geo-platform-optimizer/SKILL.md
│   ├── geo-schema/SKILL.md
│   ├── geo-technical/SKILL.md
│   ├── geo-content/SKILL.md
│   ├── geo-report/SKILL.md
│   ├── geo-report-pdf/SKILL.md
│   ├── geo-prospect/SKILL.md
│   ├── geo-proposal/SKILL.md
│   ├── geo-compare/SKILL.md
│   └── geo-update/SKILL.md
├── agents/                    # 5 parallel audit subagents
│   ├── geo-ai-visibility.md
│   ├── geo-platform-analysis.md
│   ├── geo-technical.md
│   ├── geo-content.md
│   └── geo-schema.md
├── scripts/                   # Python tool layer
│   ├── fetch_page.py          # HTTP fetch + parse (490 lines)
│   ├── citability_scorer.py   # AI citation scoring (343)
│   ├── brand_scanner.py       # Brand mention scan (276)
│   ├── llmstxt_generator.py   # llms.txt validate/generate (294)
│   ├── crm_dashboard.py       # Rich CLI CRM view (336)
│   └── webapp/                # Flask + HTMX CRM UI
│       ├── app.py             # Flask app, localhost:5050 (215)
│       └── templates/         # base/dashboard/prospect.html
├── schema/                    # JSON-LD templates by business type
│   ├── organization.json  local-business.json  article-author.json
│   ├── software-saas.json  product-ecommerce.json  website-searchaction.json
├── templates/                 # Report rendering
│   ├── geo-report-template.html
│   └── geo-report-style.css
├── white-label/               # Agency branding overrides
│   ├── brand_config.py  brand.example.json  README.md
├── tests/                     # Test artifacts
│   ├── test_fetch_page_ssr.py
│   └── agent-readiness-test-results.md
├── docs/                      # Project documentation
│   ├── architecture.md  commands-reference.md  scoring-methodology.md
│   ├── getting-started.md  faq.md  skills-and-agents.md  README.md
├── examples/                  # Sample audit/report/proposal outputs
├── assets/                    # Images / static media
├── install.sh                 # Unix installer (isolated venv)
├── install-win.sh             # Windows installer
├── uninstall.sh               # Uninstaller
├── requirements.txt           # Python deps
├── README.md  CONTRIBUTING.md  LICENSE
```

## Directory Purposes

**`geo/`:**
- Purpose: the single top-level skill that Claude loads first
- Contains: `SKILL.md` with the command table and audit orchestration logic
- Key files: `geo/SKILL.md`

**`skills/`:**
- Purpose: one sub-skill per `/geo` subcommand
- Contains: 15 subdirs, each with exactly one `SKILL.md`
- Key files: `skills/geo-audit/SKILL.md` (largest orchestration), `skills/geo-technical/SKILL.md` (532 lines)

**`agents/`:**
- Purpose: parallel analysis personas for full audits
- Contains: 5 flat `.md` files
- Key files: `agents/geo-ai-visibility.md`, `agents/geo-technical.md`

**`scripts/`:**
- Purpose: deterministic Python CLI tools invoked by skills/agents
- Contains: 5 top-level scripts + `webapp/` Flask app
- Key files: `scripts/fetch_page.py`, `scripts/citability_scorer.py`

**`schema/`, `templates/`, `white-label/`:**
- Purpose: static assets (JSON-LD, report HTML/CSS, branding)

**`docs/`:**
- Purpose: human-facing documentation; `docs/architecture.md` and `docs/scoring-methodology.md` are authoritative references

## Key File Locations

**Entry Points:**
- `geo/SKILL.md`: orchestrator / command router
- `install.sh`, `install-win.sh`: installers (create `~/.claude/skills/geo/.venv`)
- `scripts/webapp/app.py`: Flask CRM UI (`localhost:5050`)

**Configuration:**
- `requirements.txt`: Python dependencies
- `white-label/brand.example.json`: branding template (copy to `brand.json`)

**Core Logic:**
- `geo/SKILL.md`: orchestration
- `skills/geo-*/SKILL.md`: per-command logic
- `scripts/*.py`: computation

**Testing:**
- `tests/test_fetch_page_ssr.py`: pytest for fetcher SSR detection
- `tests/agent-readiness-test-results.md`: recorded agent test results

## Naming Conventions

**Files:**
- Skills/agents: lowercase `geo-<topic>` kebab-case, command-aligned (`geo-citability`, `geo-report-pdf`)
- Python scripts: `snake_case.py` (`fetch_page.py`, `crm_dashboard.py`)
- JSON-LD schemas: `kebab-case.json` named by business type (`local-business.json`)

**Directories:**
- One skill = one directory under `skills/` named `geo-<command>`
- Each contains a single `SKILL.md`

**Skill frontmatter:**
- YAML block with `name`, `description`, `allowed-tools` (e.g. `geo/SKILL.md`)

## Where to Add New Code

**New `/geo` subcommand:**
- Create `skills/geo-<command>/SKILL.md` with YAML frontmatter
- Register it in the command table in `geo/SKILL.md`

**New analysis dimension in full audit:**
- Add an agent file `agents/geo-<dimension>.md`
- Wire it into the parallel-analysis phase in `geo/SKILL.md` and `skills/geo-audit/SKILL.md`

**New deterministic tool:**
- Add `scripts/<name>.py` as a standalone CLI (argv/stdin in, JSON out)
- Include the `try/except ImportError` deps guard pattern
- Reference it from the relevant `SKILL.md` using `~/.claude/skills/geo/.venv/bin/python3`
- Add any new dep to `requirements.txt`

**New JSON-LD schema:**
- Add `schema/<business-type>.json`; reference from `skills/geo-schema/SKILL.md`

**New report styling:**
- Edit `templates/geo-report-template.html` / `templates/geo-report-style.css`

**Tests:**
- Add `tests/test_<module>.py` (pytest)

## Special Directories

**`~/.geo-prospects/` (user home, not in repo):**
- Purpose: CRM data store — `prospects.json`, `audits/`, `proposals/`
- Generated: Yes (at runtime by prospect/proposal skills + Flask app)
- Committed: No

**`~/.claude/skills/geo/.venv/` (install target):**
- Purpose: isolated Python environment created by `install.sh`
- Generated: Yes · Committed: No

**`examples/`:**
- Purpose: committed sample outputs (PDF report, audit JSON, proposal, demo prospects)
- Generated: No (hand-committed reference artifacts) · Committed: Yes

---

*Structure analysis: 2026-06-01*
