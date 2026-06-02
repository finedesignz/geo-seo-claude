---
last_mapped_commit: 9eec32f5f700a1e6c3cb1cb735a56ee5ec49a964
---
# External Integrations

**Analysis Date:** 2026-06-01

> This tool performs **unauthenticated, scraping-style** integrations against public web endpoints. There are **no API keys, OAuth flows, or secrets**. All integrations are outbound HTTP GETs with browser-like User-Agent headers.

## APIs & External Services

**Target website analysis (any user-supplied URL):**
- Arbitrary websites - fetched and parsed for GEO/SEO analysis.
  - Client: `requests` + BeautifulSoup4 (`scripts/fetch_page.py`)
  - Auth: none. Default desktop-Chrome `User-Agent` (`DEFAULT_HEADERS` in `scripts/fetch_page.py`). 30s default timeout.
  - Also fetches `robots.txt` and probes AI-crawler User-Agents (`AI_CRAWLERS` map: GPTBot, ClaudeBot, PerplexityBot, GoogleBot, BingBot).

**Brand mention scanning (public search/profile endpoints, unauthenticated):** `scripts/brand_scanner.py`
- YouTube - `https://www.youtube.com/results`
- Reddit - `https://www.reddit.com/search/`
- Quora - `https://www.quora.com/search`
- LinkedIn - `https://www.linkedin.com/search/results/companies/`
- Product Hunt - `https://www.producthunt.com/search`
- G2 - `https://www.g2.com/search`
- Trustpilot - `https://www.trustpilot.com/search`
- Crunchbase - `https://www.crunchbase.com/textsearch`
- Stack Overflow - `https://stackoverflow.com/search`
- GitHub - `https://github.com/search`
- Wikipedia API - `https://en.wikipedia.org/w/api.php`, `https://en.wikipedia.org/wiki/Special:...`
- Wikidata API - `https://www.wikidata.org/w/api.php`, `https://www.wikidata.org/w/index.php`
  - Auth: none on any. All scraped/queried as public endpoints. No SDKs; raw `requests`.

**AI-crawler reference URLs (informational, not called):**
- `https://openai.com/gptbot`, `https://www.anthropic.com/claude-bot`, `https://perplexity.ai/perplexitybot`, `http://www.google.com/bot.html`, `http://www.bing.com/bingbot.htm` — embedded in `AI_CRAWLERS` UA strings for robots.txt checks.

## Data Storage

**Databases:**
- None. No SQL/NoSQL database.

**File Storage (local filesystem only):**
- `~/.geo-prospects/prospects.json` - CRM/prospect pipeline data (read/written by `scripts/webapp/app.py` and `scripts/crm_dashboard.py`).
- `~/.geo-prospects/proposals/<domain>-proposal-<date>.md` - generated proposals.
- `~/.geo-prospects/reports/<domain>-monthly-<YYYY-MM>.md` - monthly delta reports.
- Generated audit artifacts (`GEO-*.md`, `GEO-*.pdf`, `llms.txt`, `audit-data*.json`) written to the working directory; gitignored.
- Install target: `~/.claude/skills/geo*`, `~/.claude/agents/geo-*.md`.

**Caching:**
- None.

## Authentication & Identity

**Auth Provider:**
- None. No user authentication anywhere. The Flask CRM dashboard (`scripts/webapp/app.py`, port 5050) is a local, unauthenticated dev server.

## Monitoring & Observability

**Error Tracking:**
- None. Errors collected into per-result `errors` lists (e.g. `scripts/fetch_page.py` catches `requests.exceptions.Timeout`/`ConnectionError`).

**Logs:**
- stdout/`rich` terminal output (CLI dashboard). `*.log` gitignored. No structured logging.

## CI/CD & Deployment

**Hosting:**
- None. Distributed as a Claude Code skill installed locally via `install.sh` / `install-win.sh`.

**CI Pipeline:**
- None detected (no `.github/workflows/` in tree at this scope). PR drafts present as markdown (`pr-draft-*.md`).

## Environment Configuration

**Required env vars:**
- None.

**Optional config:**
- `brand.json` (white-label) loaded by `white-label/brand_config.py` — agency name, contact, colors. No secrets.
- Flask `debug` flag toggles dev mode in `scripts/webapp/app.py`.

**Secrets location:**
- None used. `.gitignore` defensively excludes `*.key`, `*.pem`, `*.token`, `credentials.*`, `.env*`.

## Webhooks & Callbacks

**Incoming:**
- None.

**Outgoing:**
- None. (The Flask app exposes only local routes: `/`, `/prospect/<pid>`, `/prospect/<pid>/note`, `/prospect/<pid>/status`, `/prospect/<pid>/pdf`.)

## Toolchain Integrations (non-network)

- **pandoc** + **Google Chrome headless** - PDF generation pipeline (`skills/geo-report-pdf/SKILL.md`). Chrome expected at `/Applications/Google Chrome.app/` (macOS path hardcoded in skill doc).
- **Playwright** - optional browser automation for screenshots (declared in `requirements.txt`).

---

*Integration audit: 2026-06-01*
