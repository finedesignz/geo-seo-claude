#!/usr/bin/env python3
"""CONS-02 -- ottolax HTTP consumer client for the geo-api GEO audit service.

Stdlib ONLY (no pip deps): submit a URL for a GEO audit, poll until terminal,
print the score + findings. This is the reference for how the `ottolax` consumer
integrates with geo-api over HTTP.

Contract (authoritative source: geo-api `/openapi.json` + `/docs`):
  POST /audit            body {"url": "...", "callback_url"?: "..."}
                         -> 200 {"job_id": "..."} | 400 {error,message} | 401
  GET  /audit/{job_id}   -> 200 {"status": queued|running|done|failed,
                                  "score"?: number,       # only when status==done
                                  "findings"?: object,    # only when status==done
                                  "error_code"?: string}  # only when status==failed
                         | 401 | 404 (not found OR not owned)

Auth: every data route requires `Authorization: Bearer <token>`. The token is a
GEO_API_KEYS entry provisioned for the `ottolax` consumer. It is read from the
environment ONLY and is never hardcoded or printed (T-07-07).

Env:
  GEO_API_BASE_URL   base URL of geo-api (default http://localhost:8080)
  GEO_API_TOKEN      bearer token for the ottolax consumer (REQUIRED)

Usage:
  GEO_API_TOKEN=... python3 examples/ottolax-client.py https://example.com

DEFERRED-LIVE: the live round-trip needs a deployed geo-api; this script is
contract-correct but its end-to-end run is deferred until the service is live.
Cross-repo (rule 20): wiring this client into the ottolax repo is a separate
repo-scoped follow-up -- NOT done in geo-seo-claude.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

# Poll tuning: poll every POLL_INTERVAL_S up to POLL_DEADLINE_S total.
POLL_INTERVAL_S = 2.0
POLL_DEADLINE_S = 120.0
TERMINAL = ("done", "failed")


def _base_url() -> str:
    return os.environ.get("GEO_API_BASE_URL", "http://localhost:8080").rstrip("/")


def _token() -> str:
    token = os.environ.get("GEO_API_TOKEN")
    if not token:
        sys.exit("error: GEO_API_TOKEN is required (the ottolax consumer bearer token)")
    return token


def _req(method: str, path: str, body: dict | None = None) -> dict:
    """Issue an authenticated JSON request and return the parsed response dict."""
    url = _base_url() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url=url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {_token()}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.exit(f"error: {method} {path} -> HTTP {e.code}: {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"error: {method} {path} -> connection failed: {e.reason}")


def submit(url: str) -> str:
    """POST /audit {url} -> job_id."""
    result = _req("POST", "/audit", {"url": url})
    job_id = result.get("job_id")
    if not job_id:
        sys.exit(f"error: POST /audit returned no job_id: {result}")
    return job_id


def poll(job_id: str) -> dict:
    """GET /audit/{job_id} until status is terminal or the deadline elapses."""
    deadline = time.monotonic() + POLL_DEADLINE_S
    while True:
        result = _req("GET", f"/audit/{job_id}")
        status = result.get("status")
        if status in TERMINAL:
            return result
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"job {job_id} not terminal after {POLL_DEADLINE_S:.0f}s (last status={status})"
            )
        time.sleep(POLL_INTERVAL_S)


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
    print(f"submitting audit for {target} ...")
    job_id = submit(target)
    print(f"job_id={job_id}; polling ...")

    try:
        result = poll(job_id)
    except TimeoutError as e:
        print(f"timeout: {e}")
        return 2

    status = result.get("status")
    if status == "done":
        # score + findings present only on done.
        print(json.dumps({"score": result.get("score"), "findings": result.get("findings")}, indent=2))
        return 0

    # failed: error_code present.
    print(f"audit failed: error_code={result.get('error_code')}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
