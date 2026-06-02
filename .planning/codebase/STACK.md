---
last_mapped_commit: 9eec32f5f700a1e6c3cb1cb735a56ee5ec49a964
---
# Technology Stack

**Analysis Date:** 2026-06-01

## Languages

**Primary:**
- Python 3.8+ - All runtime utilities, scoring engines, scanners, web app. Located in `scripts/` and `tests/`. Minimum version is 3.8 (per `README.md`), but code uses 3.10+ union syntax (`Path | None`, `list[dict]`) in `scripts/webapp/app.py`.
- Markdown - Skill/agent definitions (the actual product). `geo/SKILL.md`, `skills/*/SKILL.md`, `agents/*.md` are Claude Code skill files, not compiled code.

**Secondary:**
- Bash - Installers/uninstaller: `install.sh`, `install-win.sh`, `uninstall.sh`.
- HTML/CSS - Report templating: `templates/geo-report-template.html`, `templates/geo-report-style.css`.
- JSON / JSON-LD - Schema templates in `schema/*.json`; white-label config `white-label/brand.example.json`.

## Runtime

**Environment:**
- CPython 3.8+ (3.10+ syntax present). This is a Claude Code skill package, not a long-running service; Python scripts are invoked on demand by skills/agents.
- An optional Flask dev server (`scripts/webapp/app.py`, runs on port 5050) and a CLI dashboard (`scripts/crm_dashboard.py`).

**Package Manager:**
- pip (default) installing from `requirements.txt`.
- `uv` (optional) - installer (`install.sh`) auto-detects and prefers `uv` for faster venv + install. See `install.sh` lines ~116, ~212.
- Lockfile: none (no `uv.lock`, no `Pipfile.lock`, no hashes). Dependencies pinned by range in `requirements.txt`.

**Isolation:**
- Dedicated venv at `~/.claude/skills/geo/.venv/` created by the installer. System Python untouched. Skill/agent files reference the venv python directly (`~/.claude/skills/geo/.venv/bin/python3`).

## Frameworks

**Core:**
- Flask >=3.0.0,<4.0.0 - CRM web dashboard (`scripts/webapp/app.py`). Jinja2 templating, routes for prospect pipeline.
- BeautifulSoup4 >=4.12.0,<5.0.0 + lxml >=6.0.2,<7.0.0 - HTML parsing in `scripts/fetch_page.py`.
- requests >=2.32.4,<3.0.0 + urllib3 >=2.6.3,<3.0.0 - HTTP fetching (`scripts/fetch_page.py`, `scripts/brand_scanner.py`).

**Testing:**
- pytest (referenced via `.pytest_cache/` in `.gitignore`; not pinned in `requirements.txt`). Single test file: `tests/test_fetch_page_ssr.py`. Uses `unittest.mock`.

**Build/Dev:**
- No build system (no `setup.py`, `pyproject.toml`, or `package.json`). Distribution is git clone + `install.sh` copying files into `~/.claude/`.
- pandoc + Google Chrome headless - PDF report pipeline (`skills/geo-report-pdf/SKILL.md`, v2.0.0). Converts `GEO-AUDIT-REPORT.md` → HTML (pandoc) → PDF (Chrome). No Python PDF deps.

## Key Dependencies

**Critical:**
- requests / urllib3 - all outbound HTTP (page fetch, robots.txt, brand scanning).
- beautifulsoup4 / lxml - DOM parsing and SSR detection.
- flask - CRM dashboard UI.

**Infrastructure:**
- playwright >=1.56.0,<2.0.0 - listed in `requirements.txt` for browser screenshots (optional per README). Note: no `playwright`/`async_playwright` import found in `scripts/` — used by skill flows, not Python utilities directly.
- Pillow >=12.1.0,<13.0.0 - image handling (screenshots).
- validators >=0.22.0,<1.0.0 - URL validation.
- rich >=13.0.0,<14.0.0 - terminal output formatting (CLI dashboard `scripts/crm_dashboard.py`).

## Configuration

**Environment:**
- No `.env` consumed by code (`.env*` is gitignored as a precaution). No API keys required — all integrations are unauthenticated public endpoints.
- White-label branding via external `brand.json` (template `white-label/brand.example.json`), loaded by `white-label/brand_config.py` (`load_brand()`), deep-merged over `DEFAULT_BRAND`.

**Build:**
- `requirements.txt` - dependency manifest (range-pinned).
- `install.sh` / `install-win.sh` - venv creation + file deployment into `~/.claude/skills/` and `~/.claude/agents/`.
- `templates/geo-report-template.html`, `templates/geo-report-style.css` - report styling.

## Platform Requirements

**Development:**
- Python 3.8+ (Debian/Ubuntu also needs `python3-venv`).
- Claude Code CLI, Git.
- Optional: `uv`, Playwright, pandoc + Chrome (for PDF reports).
- Windows supported via Git Bash only (`install-win.sh`); not PowerShell/CMD.

**Production:**
- Not a deployed service. Runs locally inside the user's Claude Code environment. Runtime data persisted to `~/.geo-prospects/` (see INTEGRATIONS.md).

---

*Stack analysis: 2026-06-01*
