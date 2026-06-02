---
last_mapped_commit: 9eec32f5f700a1e6c3cb1cb735a56ee5ec49a964
---
# Coding Conventions

**Analysis Date:** 2026-06-01

This is a Python 3 project (no `package.json`, no Node build). Source lives in
`scripts/` (CLI tools), `scripts/webapp/` (Flask UI), and `white-label/`
(brand config loader). There is **no automated linter/formatter config** in the
repo (`.flake8`, `.pylintrc`, `pyproject.toml`, `ruff.toml`, `.pre-commit-config.yaml`
all absent), so conventions below are derived from the existing code, which is
consistent and reads as PEP 8 with Black-ish formatting.

## Naming Patterns

**Files:**
- `snake_case.py` for all modules: `fetch_page.py`, `citability_scorer.py`, `brand_scanner.py`, `llmstxt_generator.py`, `crm_dashboard.py`, `brand_config.py`.
- Tests named `test_<module>_<feature>.py`: `tests/test_fetch_page_ssr.py`.

**Functions:**
- `snake_case`, verb-first, descriptive: `fetch_page`, `score_passage`, `check_youtube_presence`, `load_prospects`, `save_prospects`, `score_tier`, `load_brand`.
- Private/module helpers prefixed with `_`: `_make_response`, `_fetch_with_html` (in tests).

**Variables:**
- `snake_case`: `word_count`, `abq_score`, `parsed_url`, `definition_patterns`.

**Constants:**
- `UPPER_SNAKE_CASE` at module top: `DEFAULT_HEADERS`, `AI_CRAWLERS` (`scripts/fetch_page.py`), `DEFAULT_BRAND` (`white-label/brand_config.py`), `CRM_PATH`, `PROPOSALS_DIR` (`scripts/webapp/app.py`).

**Classes:**
- `PascalCase`. Used mainly in tests as test groupings: `TestSSRDetectionFalsePositives`, `TestSSRWordCountReported` (`tests/test_fetch_page_ssr.py`). Source code is largely function-based, not class-based.

## Code Style

**Formatting:**
- No formatter configured. Code follows PEP 8 / Black conventions: 4-space indent, double-quoted strings, trailing-comma multiline collections, aligned dict literals (see `DEFAULT_BRAND` colors in `white-label/brand_config.py`).
- One stylistic exception: single-line `if` guards used in `scripts/webapp/app.py` (`if score >= 80: return "good"`) — compact ladders for tier/label helpers. Not Black-compatible but intentional and localized.

**Linting:**
- None enforced. Tests use `# noqa: E402` to suppress the "import not at top" warning where `sys.path` manipulation must precede the import (`tests/test_fetch_page_ssr.py`).

**Line length:** Generally kept readable but long header/URL string literals exceed 100 chars (e.g. `DEFAULT_HEADERS` user-agent in `scripts/fetch_page.py`). No hard limit enforced.

## Import Organization

**Order (observed):**
1. Standard library: `import sys`, `import json`, `import re`, `from urllib.parse import ...`, `from pathlib import Path`, `from datetime import datetime`.
2. Third-party, guarded behind `try/except ImportError` with a friendly install hint (see Error Handling).
3. Local imports via `sys.path.insert` in tests.

**Third-party import guard pattern** (used in every CLI script — `scripts/fetch_page.py`, `citability_scorer.py`, `brand_scanner.py`):
```python
try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("ERROR: Required packages not installed. Run: pip install -r requirements.txt")
    sys.exit(1)
```

**Path aliases:** None. Scripts are run directly; tests reach source via
`sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))`.

## Type Hints

- Partial typing. Function signatures commonly annotate params and return: `def fetch_page(url: str, timeout: int = 30) -> dict:`, `def score_passage(text: str, heading: Optional[str] = None) -> dict:`, `def load_prospects() -> list[dict]:`.
- `Optional` imported from `typing` (`scripts/citability_scorer.py`); builtin generics `list[dict]` used in newer files (`scripts/webapp/app.py`). Python 3.9+ assumed.
- Not exhaustive — many helpers and locals are untyped. Follow the existing partial-annotation style: annotate public function signatures, skip locals.

## Error Handling

**Strategy:** Result-dict accumulation, not exceptions. Functions return a
structured `dict` with an `"errors"` list rather than raising. Callers inspect
fields like `result["has_ssr_content"]` and `result["errors"]`.

**Patterns:**
- Initialize a full result dict with all keys defaulted up front (`fetch_page` initializes ~20 keys including `"errors": []`), then mutate.
- Append human-readable strings to `result["errors"]`: `result["errors"].append(f"Unsupported URL scheme: {parsed_url.scheme!r}. ...")`.
- Validate inputs early and short-circuit by returning the partial result.
- Network/IO wrapped in `try/except` around `requests.get(...)`.
- Hard-fail only on missing dependencies (`sys.exit(1)` after the import guard).

**CLI argument validation:** Manual `len(sys.argv)` checks with usage message
and `sys.exit(1)` (`scripts/fetch_page.py`, `brand_scanner.py`, `citability_scorer.py`).
`scripts/crm_dashboard.py` is the one script using `argparse`.

## Logging

**Framework:** None. Scripts communicate via `print()`:
- Errors → `print("ERROR: ...")` to stdout before `sys.exit(1)`.
- Primary output → `print(json.dumps(result, indent=2, default=str))` — every CLI tool emits JSON to stdout as its contract (this is how Claude Code skills consume the tools). `rich` is a dependency for terminal formatting in `crm_dashboard.py`.

## Comments & Docstrings

**Module docstrings:** Every module opens with a triple-quoted docstring stating
purpose, and often research citations / usage examples (see `scripts/brand_scanner.py`
header citing the "Ahrefs December 2025 study", `white-label/brand_config.py` with a
`Usage` section). Maintain this — module docstrings are expected.

**Function docstrings:** One-line imperative summaries: `"""Fetch a page and return structured analysis data."""`, `"""Score a single passage for AI citability (0-100)."""`.

**Inline comments:** Section banners used to structure long functions:
`# === 1. Answer Block Quality (30%) ===` (`scripts/citability_scorer.py`) and
box-drawing dividers `# ── Helpers ────` (`scripts/webapp/app.py`). Used to delimit
logical blocks within large functions.

## Function & Module Design

**Functions:** Tend to be long and procedural (scoring functions span 50–100+ lines),
organized internally with numbered section-banner comments. Each returns a dict.

**Module entry point:** Every CLI script ends with an `if __name__ == "__main__":`
block that reads `sys.argv`, calls the core function, and prints JSON. Keep this
pattern for new tools.

**Exports:** No `__all__`, no barrel files, no package `__init__.py` re-exports.
Modules are flat and imported by direct module name.

## Git Commit Messages (from `CONTRIBUTING.md`)
- Present tense, imperative mood ("Add feature", not "Added feature").
- First line ≤ 72 chars; reference issues/PRs after the first line.
- Update `/docs` when changing code/behavior.

---

*Convention analysis: 2026-06-01*
