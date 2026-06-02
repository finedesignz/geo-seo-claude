---
last_mapped_commit: 9eec32f5f700a1e6c3cb1cb735a56ee5ec49a964
focus: concerns
analysis_date: 2026-06-01
---

# Codebase Concerns

**Analysis Date:** 2026-06-01

This is a Python-based GEO/SEO toolkit: a set of Claude Code skills (`skills/`), standalone
analysis scripts (`scripts/`), a small Flask CRM web UI (`scripts/webapp/`), and a white-label
config layer (`white-label/`). Concerns below are grounded in the actual code.

## Tech Debt

**Single shared `requests.get` boilerplate duplicated across scripts:**
- Issue: `DEFAULT_HEADERS` and the same `requests.get(..., headers=..., timeout=...)` pattern are
  copy-pasted into every script rather than centralized. The browser User-Agent string is
  hardcoded in at least four places.
- Files: `scripts/fetch_page.py` (lines 28-33), `scripts/brand_scanner.py` (lines 28-32),
  `scripts/citability_scorer.py` (lines 250-256, inline UA), `scripts/llmstxt_generator.py`,
  `scripts/crm_dashboard.py`.
- Impact: UA/header/timeout changes must be made in N places; easy to drift (citability_scorer
  already uses a different/shorter UA than the others).
- Fix approach: extract a shared `http.py` helper (single `get()` with headers, timeout, retries,
  size cap, SSRF guard) and import it everywhere.

**Broad `except Exception` / bare `except` swallowing errors silently:**
- Issue: Many network and parse paths catch `Exception` and either `pass` or append a generic
  string, discarding the real failure mode.
- Files: `scripts/brand_scanner.py` (lines 131, 145 — `except Exception: pass`),
  `scripts/fetch_page.py` (lines 195, 303, 329, 436, 452), `scripts/citability_scorer.py`
  (line 258), `scripts/llmstxt_generator.py` (lines 116, 124).
- Impact: real bugs (bad JSON shape, DNS, TLS) are indistinguishable from "site has no data";
  silent `pass` in `crawl_sitemap` (lines 436, 452) hides child-sitemap fetch failures so results
  look complete when they are partial.
- Fix approach: narrow except clauses (`requests.RequestException`, `json.JSONDecodeError`), log
  the exception type, and surface partial-result flags in the JSON output.

**No dependency pinning to exact versions:**
- Issue: `requirements.txt` uses floating ranges (`requests>=2.32.4,<3.0.0`, etc.) with no
  lockfile committed.
- Files: `requirements.txt`.
- Impact: non-reproducible installs; a patch release of `lxml`/`beautifulsoup4`/`playwright` can
  change parse behavior under users without any repo change. `playwright>=1.56` also implies a
  browser-binary download step that is not version-locked.
- Fix approach: add a `requirements.lock` / `uv.lock` (project already references `uv` in
  `install.sh`) and pin transitive deps.

## Known Bugs

**`robots.txt` Sitemap-line parser corrupts URLs with ports or `https`:**
- Symptoms: `fetch_robots_txt` splits each line on the first `:` (`line.split(":", 1)`), so a
  `Sitemap: https://...` line yields `https://...` correctly, but the defensive re-prepend logic
  at `scripts/fetch_page.py` lines 263-264 (`if not sitemap_url.startswith("http"): sitemap_url =
  "http" + sitemap_url`) will mangle any sitemap value that legitimately does not start with
  `http` (relative or scheme-less), producing `httpsitemap...`-style garbage.
- Files: `scripts/fetch_page.py` (lines 260-265).
- Trigger: a robots.txt with a non-`http` Sitemap directive, or `User-agent`/`Disallow` values
  containing a `:` (e.g. a path with a colon) — `split(":", 1)` keeps everything after the first
  colon, which is correct for paths but the directive matching is purely prefix-based and
  case-handled inconsistently.
- Workaround: none in code; downstream consumers must re-validate sitemap URLs.

**SSR detection is heuristic and brittle:**
- Symptoms: `has_ssr_content` is flipped to `False` only when a framework-root div has `<50` chars
  AND total page words `<200` (`scripts/fetch_page.py` lines 176-189). Pages that are genuinely
  client-rendered but ship a large static shell, or SSR pages with tiny visible text, are
  misclassified.
- Files: `scripts/fetch_page.py` (lines 130-189).
- Trigger: SPA with prerendered marketing copy, or content-light SSR pages.
- Workaround: treat `has_ssr_content` as advisory, not authoritative.

**Platform "presence" checks infer existence from search-result HTML / counts:**
- Symptoms: `brand_scanner.py` decides `has_wikipedia_page` by checking if the brand name is a
  substring of the top Wikipedia search title (line 125-126), and other platforms are reduced to
  pre-built `search?q=` URLs rather than verified presence. Substring matching produces false
  positives (generic brand names) and false negatives (disambiguated titles).
- Files: `scripts/brand_scanner.py` (lines 110-145, 200-210).
- Trigger: common/short brand names, or brands whose Wikipedia title differs from the query.
- Workaround: manual verification; treat output as a lead, not a fact.

## Security Considerations

**SSRF: no private-network / internal-host validation before fetching:**
- Risk: `fetch_page` validates only the URL scheme (`http`/`https`, lines 60-63) but never the
  resolved host. Any caller-supplied URL can target `127.0.0.1`, `169.254.169.254` (cloud
  metadata), `localhost`, or RFC-1918 ranges. `requests.get(..., allow_redirects=True)` also
  follows redirects to internal hosts. `crawl_sitemap` recursively fetches arbitrary child-sitemap
  `loc` URLs taken from remote XML with no validation (lines 418-433).
- Files: `scripts/fetch_page.py` (lines 60-71, 233, 323, 411-433, 477), `scripts/brand_scanner.py`
  (lines 121, 137), `scripts/citability_scorer.py` (lines 250-256),
  `scripts/llmstxt_generator.py` (lines 58, 121, 144, 252).
- Current mitigation: scheme allow-list only.
- Recommendations: resolve the hostname and reject private/loopback/link-local/reserved IPs before
  the request; disable or re-validate on redirect; cap redirect count; apply the same guard to
  sitemap-discovered URLs.

**No response-size cap — memory-exhaustion / DoS via large responses:**
- Risk: every fetch uses `requests.get(...)` without `stream=True` and reads `response.text`
  fully into memory; a hostile or huge page/sitemap is loaded entirely. `BeautifulSoup(...,
  "lxml")` then parses the whole blob.
- Files: `scripts/fetch_page.py` (line 66, 95, 415), `scripts/citability_scorer.py` (line 250),
  `scripts/brand_scanner.py`, `scripts/llmstxt_generator.py`.
- Current mitigation: per-request timeout only (does not bound body size).
- Recommendations: stream with a max-bytes guard; reject `Content-Length` over a threshold.

**Flask CRM has no authentication and is JSON-file backed:**
- Risk: `scripts/webapp/app.py` exposes dashboard, prospect detail, note add, status update, and
  PDF download with zero auth. It mutates `~/.geo-prospects/prospects.json` on POST. If bound to
  anything but loopback it leaks CRM/PII and allows unauthenticated writes.
- Files: `scripts/webapp/app.py` (all routes; `app.run(debug=debug, port=5050)` line 215 binds
  default host).
- Current mitigation: intended for localhost; `FLASK_DEBUG` is env-gated (line 214) so the
  debugger/PIN is off by default.
- Recommendations: bind explicitly to `127.0.0.1`; add a note/guard against `0.0.0.0`; if remote
  access is ever needed, put auth (Titanium licensing per house rules) in front.

**PDF download path built from prospect-controlled `domain` glob:**
- Risk: `find_pdf` globs `PROPOSALS_DIR.glob(f"{domain}*.pdf")` using `prospect["domain"]`
  (`app.py` lines 74-79). The value comes from the JSON store; a crafted `domain` containing glob
  metacharacters could broaden the match. `send_file` itself is scoped to the matched path, so
  this is low severity, but the pattern is fragile.
- Files: `scripts/webapp/app.py` (lines 74-79, 192-208).
- Current mitigation: matches are confined to `PROPOSALS_DIR`; no user-supplied path traversal
  reaches `send_file` directly.
- Recommendations: sanitize/whitelist `domain` characters before globbing.

**Install-via-pipe pattern:**
- Risk: `install.sh` / `install-win.sh` explicitly detect "running via curl pipe" (line 24/16),
  implying a `curl ... | bash` install flow, which executes remote code unverified and runs
  `pip install` of unpinned deps and `chmod +x` on hook files.
- Files: `install.sh`, `install-win.sh`, `uninstall.sh`.
- Current mitigation: none beyond user trust.
- Recommendations: document checksum/tag verification; encourage download-then-inspect-then-run.

## Performance Bottlenecks

**Serial, blocking network fan-out:**
- Problem: brand scanning, citability page analysis, and sitemap crawling issue many `requests.get`
  calls sequentially with 10-30s timeouts each. A multi-platform brand scan or a 50-page sitemap
  crawl blocks linearly.
- Files: `scripts/brand_scanner.py` (per-platform checks), `scripts/fetch_page.py`
  `crawl_sitemap` (lines 398-455, up to `max_pages=50` sequential child fetches),
  `scripts/llmstxt_generator.py` (line 252 per-page fetch loop).
- Cause: no concurrency; each call waits on the prior.
- Improvement path: bounded thread pool / async for the fan-out; reuse a `requests.Session` for
  connection pooling (currently a fresh connection per call).

**Full-document re-parse per analysis mode:**
- Problem: `fetch_page.py` `full` mode (lines 479-485) calls `fetch_page`, `fetch_robots_txt`,
  `fetch_llms_txt`, and `crawl_sitemap` independently, each re-fetching/re-parsing; the main page
  may be fetched and BeautifulSoup-parsed more than once across modes.
- Files: `scripts/fetch_page.py` (lines 458-490), `scripts/citability_scorer.py` (re-fetches the
  page it analyzes, lines 248-260).
- Improvement path: fetch once, pass parsed soup/HTML between analyzers.

## Fragile Areas

**HTML-structure-dependent scraping of third-party platforms:**
- Files: `scripts/brand_scanner.py` (Quora/StackOverflow/GitHub/ProductHunt/Trustpilot search
  URLs, lines 200-210), `scripts/citability_scorer.py`, `scripts/llmstxt_generator.py`.
- Why fragile: relies on third-party search-page markup and anti-bot tolerance. Any DOM change,
  rate-limit, captcha, or 403 silently degrades results (swallowed by broad excepts above).
- Safe modification: prefer official APIs where they exist (Wikipedia/Wikidata already do, lines
  119-121, 136-137); gate scraped platforms behind explicit "best-effort" flags.
- Test coverage: none for these paths.

**SSR/decompose ordering coupling in `fetch_page`:**
- Files: `scripts/fetch_page.py` (lines 122-189).
- Why fragile: structured-data extraction, SSR measurement, and `decompose()` are order-dependent
  (comments at lines 122, 130, 145 warn that measurements must run before the destructive
  `decompose()`). Reordering silently breaks SSR detection and JSON-LD capture.
- Safe modification: only the existing `tests/test_fetch_page_ssr.py` (14 tests) guards SSR; extend
  it before touching this block.
- Test coverage: SSR path covered; structured-data/links/images paths uncovered.

**White-label config layer:**
- Files: `white-label/brand_config.py`, `white-label/` configs.
- Why fragile: report/proposal generation interpolates brand strings; placeholder tokens like
  `$X,XXX/month` and `XX%` appear directly in skill output templates (`skills/geo-report/SKILL.md`
  lines 76, 290) and must be filled by the model — if not substituted they ship to clients
  verbatim.
- Safe modification: validate that no `$X,XXX` / `XX%` placeholders survive into generated
  reports.

## Scaling Limits

**JSON-file persistence with full read-modify-write:**
- Current capacity: every CRM mutation (`add_note`, `update_status`) does
  `load_prospects()` → mutate → `save_prospects()` rewriting the entire `prospects.json`
  (`scripts/webapp/app.py` lines 31-39, 152-189).
- Limit: no locking — concurrent requests race and can lose writes; O(n) full-file rewrite per
  edit; in-memory linear `next(... for x in prospects)` lookups by id.
- Scaling path: move to SQLite/Postgres with row-level updates and a real index if the CRM grows
  beyond single-user local use.

**Sitemap crawl hard-capped at 50 pages:**
- Current capacity: `crawl_sitemap(max_pages=50)` (`scripts/fetch_page.py` line 398).
- Limit: large sites are silently truncated; sitemap-index children are only partially walked
  before the cap.
- Scaling path: paginate/stream and make the cap explicit in output.

## Dependencies at Risk

**Playwright (heavy, browser-binary coupled):**
- Risk: `playwright>=1.56.0,<2.0.0` pulls a large runtime and requires a separate browser install
  step; version skew between the pip package and installed browser breaks rendering.
- Impact: any JS-rendering analysis path fails on environments where the browser was not installed
  or is mismatched.
- Migration plan: ensure `playwright install` is part of setup and pin the browser revision; make
  Playwright optional/lazy-imported so non-rendering scripts work without it.

**`lxml` parser dependency:**
- Risk: every `BeautifulSoup(..., "lxml")` call hard-depends on the C `lxml` build; wheel
  availability/ABI issues on some platforms.
- Impact: total failure of all parsing if `lxml` is unavailable.
- Migration plan: fall back to the stdlib `html.parser` when `lxml` import fails.

## Missing Critical Features

**No request throttling / politeness controls:**
- Problem: scrapers send rapid sequential requests to third-party sites with a spoofed desktop
  User-Agent and no delay, robots respect, or rate limiting.
- Blocks: safe/ethical operation at scale; risks IP bans that silently zero-out results.

**No structured logging or run audit trail:**
- Problem: scripts `print(json.dumps(...))` results and append error strings into the payload; the
  Flask app uses default logging. There is no consistent log of what was fetched, when, or why a
  fetch failed.
- Blocks: debugging field failures and reproducing client reports.

## Test Coverage Gaps

**Only one test module exists:**
- What's not tested: everything except SSR detection. `tests/` contains only
  `test_fetch_page_ssr.py` (14 `test_` functions) plus a results markdown
  (`agent-readiness-test-results.md`). No tests for `robots.txt`/`llms.txt` parsing, sitemap
  crawl, `brand_scanner`, `citability_scorer`, `llmstxt_generator`, `crm_dashboard`, or the Flask
  `webapp`.
- Files: untested — `scripts/brand_scanner.py`, `scripts/citability_scorer.py`,
  `scripts/llmstxt_generator.py`, `scripts/crm_dashboard.py`, `scripts/webapp/app.py`,
  `white-label/brand_config.py`, and the non-SSR branches of `scripts/fetch_page.py`.
- Risk: parser/scoring regressions and the SSRF/size-cap gaps ship unnoticed; robots/sitemap
  parsing bugs (above) have no guard.
- Priority: High for `fetch_page` network/parse helpers and any SSRF/size fix; Medium for scoring
  scripts; Medium for the Flask CRM.

**No CI:**
- Problem: no `.github/workflows/` directory; the 14 existing tests are not run automatically on
  push/PR, and there is no lint/type/security (e.g. `bandit`) gate. Per house rule 21 this repo
  should also expose `/openapi.json` + `/docs` and ship docs-drift CI — none present.
- Risk: regressions and security issues land without a gate.
- Priority: High.

---

*Concerns audit: 2026-06-01*
