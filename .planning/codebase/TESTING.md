---
last_mapped_commit: 9eec32f5f700a1e6c3cb1cb735a56ee5ec49a964
---
# Testing Patterns

**Analysis Date:** 2026-06-01

Testing in this repo is **minimal and early-stage**. There is a single
pytest-style suite, `tests/test_fetch_page_ssr.py`, plus a manual results log
`tests/agent-readiness-test-results.md`. No test runner config, no CI workflow
(`.github/` absent), and no coverage tooling exist yet. `pytest` is **not** in
`requirements.txt` — it must be installed separately to run the suite.

## Test Framework

**Runner:**
- pytest (inferred — tests use pytest class/function collection conventions, no `unittest.main()`). **Not pinned** in `requirements.txt`; install manually: `pip install pytest`.
- No `pytest.ini`, `pyproject.toml`, `tox.ini`, or `setup.cfg`.

**Assertion library:**
- Plain `assert` statements (pytest-style), with explanatory failure messages as the second tuple element:
  ```python
  assert result["has_ssr_content"] is True, (
      "WordPress/Bricks Builder site should not be flagged as CSR"
  )
  ```

**Mocking:**
- `unittest.mock` (`patch`, `MagicMock`) from the standard library.

**Run commands:**
```bash
pip install -r requirements.txt   # runtime deps
pip install pytest                # test runner (not in requirements.txt)
pytest tests/                     # run all tests
pytest tests/test_fetch_page_ssr.py -v   # verbose single file
pytest -k SSRDetection            # run by keyword/class name
```

## Test File Organization

**Location:** Separate top-level `tests/` directory (not co-located with source
in `scripts/`).

**Naming:** `test_<module>_<feature>.py` — `tests/test_fetch_page_ssr.py` tests
the SSR-detection feature of `scripts/fetch_page.py`.

**Importing source under test:** Source is reached by inserting `scripts/` onto
`sys.path` at the top of the test module (no installable package):
```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from fetch_page import fetch_page  # noqa: E402
```
Replicate this pattern for new test files targeting `scripts/` modules.

## Test Structure

**Suite organization:** Behavior grouped into `PascalCase` test classes with
docstrings explaining the scenario; each test is a `test_*` method:
```python
class TestSSRDetectionFalsePositives:
    """Sites that use framework root divs but serve full SSR HTML must NOT be flagged."""

    def test_wordpress_bricks_not_flagged(self):
        result = _fetch_with_html(WORDPRESS_BRICKS_HTML)
        assert result["has_ssr_content"] is True, (
            "WordPress/Bricks Builder site should not be flagged as CSR"
        )
```

**Conventions:**
- Classes group related cases by scenario: `TestSSRDetectionNonFrameworkSites`, `TestSSRDetectionFalsePositives`, `TestSSRDetectionTruePositives`, `TestSSRWordCountReported`, `TestSSRDecomposeOrderIndependence`.
- Tests are issue-driven and document the bug they cover (module docstring references "GitHub Issue #19").
- No setup/teardown methods, no fixtures decorators (`@pytest.fixture` unused) — state is built per-test via helpers.

## Mocking

**Framework:** `unittest.mock.patch` + `MagicMock`.

**Pattern — patch the network call, inject HTML:**
```python
def _make_response(html: str, status_code: int = 200):
    """Build a minimal mock requests.Response."""
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    mock_resp.text = html
    mock_resp.history = []
    mock_resp.headers = {}
    mock_resp.url = "http://example.com/"
    return mock_resp

def _fetch_with_html(html: str) -> dict:
    with patch("fetch_page.requests.get", return_value=_make_response(html)):
        return fetch_page("http://example.com/")
```

**What to mock:** External HTTP (`requests.get`) is patched at the module path
where it is *used* (`fetch_page.requests.get`), never hitting the network.

**What NOT to mock:** The unit under test (`fetch_page` parsing/heuristic logic)
runs for real — only its I/O boundary is stubbed.

## Fixtures & Test Data

- Test data = module-level multiline HTML string constants (no external fixture
  files): `WORDPRESS_BRICKS_HTML`, `LITESPEED_CACHE_HTML`, `PRERENDER_SERVICE_HTML`,
  `TRUE_CSR_SHELL_HTML`, `TRUE_CSR_ROOT_HTML`, `NO_FRAMEWORK_HTML`.
- Each constant is a realistic, self-documenting HTML page representing one
  scenario. Add new scenarios as new top-level constants and a matching test.
- No `conftest.py`, no factory libraries.

## Coverage

**Requirements:** None enforced. No coverage tool configured.

**Current scope:** Only `scripts/fetch_page.py`'s SSR-detection heuristic is
covered. Untested: `citability_scorer.py`, `brand_scanner.py`, `llmstxt_generator.py`,
`crm_dashboard.py`, the Flask app in `scripts/webapp/app.py`, and
`white-label/brand_config.py`. See `CONCERNS.md` for the coverage-gap risk.

**View coverage (if added):**
```bash
pip install pytest-cov
pytest --cov=scripts tests/
```

## Test Types

**Unit tests:** The sole automated type — pure-function heuristic tests with the
HTTP boundary mocked (`tests/test_fetch_page_ssr.py`).

**Integration / E2E:** None automated. `tests/agent-readiness-test-results.md` is
a manual, human-recorded results log (markdown), not an executable test.

## Common Patterns

**Boolean/identity assertions:** Prefer `is True` / `is False` for the
`has_ssr_content` flag rather than truthiness.

**Error-list assertions:** Filter the result's `errors` list and assert on it:
```python
csr_errors = [e for e in result["errors"] if "client-side" in e.lower()]
assert csr_errors == []          # expect no CSR error
assert len(csr_errors) >= 1      # expect a CSR error was recorded
```

**Message-content assertions:** Verify error strings contain expected substrings
(e.g. word count): `assert any("word" in e for e in csr_errors)`.

---

*Testing analysis: 2026-06-01*
