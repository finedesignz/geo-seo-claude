# Pitfalls Research

**Domain:** FastAPI async job service wrapping headless `claude -p` scoring, SSRF-exposed URL fetcher, Postgres job queue, Coolify container deploy
**Researched:** 2026-06-01
**Confidence:** HIGH (grounded in CONCERNS.md codebase audit + domain knowledge of each subsystem)

---

## Critical Pitfalls

### Pitfall 1: Headless `claude -p` Hangs on Interactive Auth Prompts in Container

**What goes wrong:**
`claude -p` inside a Docker container stalls indefinitely waiting for a TTY-based login prompt, MFA flow, or subscription confirmation that never arrives. The FastAPI worker spawns the process, it blocks forever, the job never completes, and no timeout fires because the process is running (not crashed).

**Why it happens:**
`claude -p` is designed for non-interactive pipelines but the subscription auth path was designed for a logged-in desktop user. On first run (or after token expiry), the CLI opens an interactive OAuth/browser flow. Containers have no browser, no TTY, and no X display. The subprocess appears alive to `asyncio`/`subprocess` but is deadlocked waiting for stdin/a port callback that never comes.

**How to avoid:**
- Run the de-risk spike (PROJECT.md requirement) in an actual container image first — not on the dev machine — to verify auth token bake-in is possible.
- Bake the Claude auth token/credential files into the container image build step (copy from host `~/.claude/` during a privileged build stage, or mount as a read-only secret volume at runtime).
- Add a strict `timeout` to every `subprocess.run` / `asyncio.create_subprocess_exec` call (e.g. `asyncio.wait_for(..., timeout=300)`).
- Capture both `stdout` and `stderr`; if stderr contains `"login"`, `"auth"`, `"subscription"`, or `"browser"` treat it as a hard failure, not a timeout.
- Test auth token expiry behavior explicitly — tokens may be time-limited; add a token-freshness health check to the `/health` endpoint.

**Warning signs:**
- Jobs stuck in `running` state for >5 minutes with no output rows.
- Subprocess PID exists but CPU/memory usage is zero.
- `stderr` contains `"Opening browser"`, `"Please authenticate"`, or similar.
- Container logs show `claude` processes accumulating without completing (zombie accumulation — global rule 23).

**Phase to address:**
Phase 1 (De-risk spike: headless `claude -p` in container). This is the project's single highest-risk unknown; it must be resolved before any other build work.

---

### Pitfall 2: SSRF via Private/Link-Local IP Access Through `fetch_page.py`

**What goes wrong:**
A caller POSTs `{"url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"}` (AWS metadata), `http://10.0.0.1/`, `http://localhost:5432/`, or any RFC-1918/loopback address. The existing `fetch_page.py` only validates scheme (`http`/`https`) — it does not resolve or validate the destination IP. The request fires from inside the container against the Coolify host network, leaking cloud metadata, Postgres credentials, or internal service responses into the API response.

**Why it happens:**
SSRF is the canonical mistake when adding "fetch any URL" to an API. The CONCERNS.md already documents it (lines 86-99) but no fix is in place. The attack surface is compounded by three factors specific to this codebase: (1) `crawl_sitemap` recursively fetches child-sitemap `loc` URLs from attacker-controlled XML with no validation; (2) `allow_redirects=True` follows chains that may terminate at a private IP; (3) `brand_scanner.py`, `citability_scorer.py`, and `llmstxt_generator.py` also call `requests.get` on caller-influenced URLs.

**How to avoid:**
- Resolve the hostname to an IP before calling `requests.get`; reject if the IP is in any of: loopback (`127.0.0.0/8`), link-local (`169.254.0.0/16`), RFC-1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), IPv6 ULA (`fc00::/7`), or `::1`.
- Implement a `custom_dns_resolver` that validates on each hop — not just before the first request — to defeat DNS rebinding: resolve → validate → connect, re-validate after each redirect.
- Set `allow_redirects=False` on the initial call; follow redirects manually, re-validating the destination IP at each hop; cap redirect count at 3.
- Extract a shared `http.py` helper (already recommended in CONCERNS.md tech debt section) that centralises the SSRF guard, size cap, and timeout — apply it to ALL scripts, not just `fetch_page.py`.
- Apply the same guard to every `loc` URL extracted from sitemap XML — treat them as untrusted input.

**Warning signs:**
- Any `requests.get` call that accepts a URL parameter without an IP-validation step before it.
- `allow_redirects=True` anywhere in the fetch chain.
- Sitemap crawl that calls `requests.get(loc_url)` without first passing through the SSRF guard.

**Phase to address:**
Phase 2 (SSRF hardening + shared `http.py` helper). Must complete before `POST /audit` is wired to any network path — i.e., before the FastAPI service is deployed anywhere reachable.

---

### Pitfall 3: Memory Exhaustion / Decompression Bomb via Unbounded Response Reads

**What goes wrong:**
A hostile site returns a 500 MB HTML page, a gzip bomb (tiny compressed → gigabytes expanded), or a 1 GB XML sitemap. `requests.get(...).text` loads the entire body into memory. `BeautifulSoup(..., "lxml")` then parses the whole blob. Inside a container with fixed memory limits (Coolify), this OOM-kills the container — killing all in-flight jobs, not just the offending request.

**Why it happens:**
CONCERNS.md documents this (lines 100-108). The fix is absent. Every script does full `response.text` reads. No `stream=True`, no `Content-Length` pre-check, no `max_bytes` guard.

**How to avoid:**
- In `http.py`, use `response = requests.get(..., stream=True)` and read with `response.iter_content(chunk_size=8192)` up to a hard cap (e.g. 5 MB for HTML, 10 MB for sitemaps); raise `ResponseTooLargeError` if exceeded.
- Pre-check `Content-Length` header and reject before reading if over threshold.
- For gzip: `requests` auto-decompresses; limit post-decompression bytes, not just wire bytes — keep a running byte counter across chunks.
- Set container memory limits in Coolify explicitly (e.g. 1 GB) so OOM kills the container process, not the host.

**Warning signs:**
- Any `requests.get(url).text` without a `stream=True` + byte-counter pattern.
- `Content-Length` header not checked before reading.
- Container OOM kills in Coolify logs.

**Phase to address:**
Phase 2 (SSRF hardening + response-size caps) — same `http.py` helper.

---

### Pitfall 4: DNS Rebinding Bypasses Pre-Request IP Validation

**What goes wrong:**
The SSRF guard resolves `attacker.com` to a public IP at validation time. The DNS TTL expires. On the actual `requests.get` call milliseconds later, `attacker.com` re-resolves to `169.254.169.254`. Validation passed; the request hits the metadata service.

**Why it happens:**
Single-point validation before the request is a textbook DNS rebinding bypass. Python's `requests` library uses the OS resolver at connection time, not the pre-checked IP.

**How to avoid:**
- After resolving and validating the IP, connect directly to the IP, not the hostname. Construct the request against the resolved IP and pass the original hostname in the `Host` header manually.
- Alternatively, use a custom `urllib3` transport adapter that pins the resolved IP on the socket level.
- Never validate the hostname and then pass the hostname back to `requests` to re-resolve.

**Warning signs:**
- SSRF guard that calls `socket.getaddrinfo(host)` and checks the result, but then still calls `requests.get(original_url)`.

**Phase to address:**
Phase 2 (SSRF hardening). Address in the `http.py` helper alongside the basic private-IP check.

---

### Pitfall 5: FastAPI `BackgroundTasks` Jobs Silently Die on Redeploy

**What goes wrong:**
An audit job is running in a `BackgroundTasks` coroutine when Coolify redeploys the container. The container receives SIGTERM; FastAPI shuts down; the background task is killed mid-execution. The Postgres row stays in `running` state forever — no timeout, no error, no retry. Consumer apps poll forever.

**Why it happens:**
`BackgroundTasks` in FastAPI are fire-and-forget coroutines tied to the request lifecycle, not a durable job queue. They have no persistence layer, no crash recovery, and no awareness of process lifecycle. This is the correct mechanism for very fast tasks (e.g. sending one email), but is wrong for multi-minute audit runs.

**How to avoid:**
- Use a proper worker process separate from the FastAPI web process: a dedicated `asyncio` worker loop that pulls jobs from a Postgres `jobs` table, or a lightweight task queue backed by Postgres (e.g. `pgqueuer` or a hand-rolled `SKIP LOCKED` `SELECT FOR UPDATE` poller).
- The FastAPI handler only inserts the job row and returns `job_id`. A separate worker process (same container or sidecar) picks up and executes the job.
- Add a `locked_until` / `heartbeat_at` column; a reaper resets jobs where `heartbeat_at < NOW() - interval '10 minutes'` to `queued`.
- Set `SIGTERM` handler in the worker to finish the current job before exiting (or checkpoint state into the DB).

**Warning signs:**
- `BackgroundTasks` used for any task expected to take >10 seconds.
- No `status` column reaper / stuck-job recovery in the schema design.
- Jobs table has no `heartbeat_at` or `locked_until`.

**Phase to address:**
Phase 3 (FastAPI service + async job model). Must be addressed in the initial schema and worker design — retrofitting a job queue after the fact is a rewrite.

---

### Pitfall 6: Blocking the FastAPI Event Loop with Synchronous Scraper Calls

**What goes wrong:**
`scripts/fetch_page.py`, `brand_scanner.py`, `citability_scorer.py` all use synchronous `requests.get`. Calling them directly from an `async def` FastAPI route or a `BackgroundTasks` coroutine blocks the entire uvicorn event loop for the duration of each network call (10–30 s each, multiplied by the ~50-page sitemap crawl). All other in-flight requests — including job status polls — time out.

**Why it happens:**
`requests` is a blocking I/O library. Awaiting a sync function inside an `async def` does not make it non-blocking; it simply runs synchronously on the event loop thread. The CONCERNS.md already flags "serial, blocking network fan-out" (lines 139-150).

**How to avoid:**
- Wrap every scraper call in `asyncio.get_event_loop().run_in_executor(None, blocking_fn)` (or `anyio.to_thread.run_sync`) to offload to a thread pool.
- Set a bounded `ThreadPoolExecutor` (e.g. `max_workers=4`) on the FastAPI lifespan to cap concurrent scrape threads; do not use the default unbounded executor.
- Long-term: replace `requests` with `httpx` (async) in the shared `http.py` helper; keep sync wrappers for backward compatibility.

**Warning signs:**
- Any `requests.get(...)` inside an `async def` function without `run_in_executor`.
- `/audit/{job_id}` status polls timing out during an active audit.
- Uvicorn worker logs show request queue depth building during audits.

**Phase to address:**
Phase 3 (FastAPI service). Address in the job worker design; run scrapers in a thread pool from day one.

---

### Pitfall 7: No Concurrency Cap on Parallel Audit Jobs

**What goes wrong:**
Ten consumers each POST `/audit` simultaneously. Each audit spawns a `claude -p` subprocess (potentially using gigabytes of RAM and saturating the Claude CLI rate limits), plus 50+ concurrent scrape threads. The container OOMs, or all `claude -p` invocations hit subscription rate limits simultaneously and fail, leaving all 10 jobs in an error state.

**Why it happens:**
Without a semaphore or queue depth limit, every job runs immediately when picked up. Nothing prevents N jobs from running in parallel where N is bounded only by incoming request rate.

**How to avoid:**
- Enforce a `max_concurrent_audits` config (start at 2–3 given `claude -p` memory footprint).
- In the worker loop, use `asyncio.Semaphore(max_concurrent_audits)` before launching each job.
- Jobs that exceed the concurrency cap stay in `queued` state and are picked up as slots free.
- Expose current queue depth and active count on `/health` so Coolify / consumer apps can backpressure.

**Warning signs:**
- No semaphore or `max_workers` cap in the job worker.
- More `claude` PIDs than expected in container `ps aux`.
- Sudden spike in `failed` jobs after load.

**Phase to address:**
Phase 3 (FastAPI service + job worker).

---

### Pitfall 8: Claude Subscription Auth Not Persisted Across Container Restarts

**What goes wrong:**
The `claude` CLI auth token/session is stored in the container's ephemeral filesystem (e.g. `~/.claude/` inside the running container). Coolify redeploys a new container image. The new container has no auth token. All `claude -p` invocations immediately hang on the interactive auth prompt (Pitfall 1), or fail with a subscription error. All queued jobs fail.

**Why it happens:**
Container filesystems are ephemeral by default. Auth state written at runtime (or copied during `docker build`) is lost when the image is replaced. This is different from baking credentials into the image at build time — runtime auth mutations (token refresh) are also lost.

**How to avoid:**
- Mount the Claude auth directory as a Coolify persistent volume: `/root/.claude/` → persistent volume named `claude-auth`. Pre-populate it once from the host.
- OR bake a non-expiring token into the image at build time (verify token TTL with Claude CLI docs — subscription tokens may be long-lived).
- In the `/health` endpoint, include a `claude_auth_valid: bool` check by running `claude --version` or a minimal `claude -p "ping"` and verifying it returns without an auth error.
- Add a startup probe in Coolify (`/health` returning 200 only when `claude_auth_valid: true`) so a redeployed container with missing auth never enters the load balancer rotation.

**Warning signs:**
- `/health` check passes (HTTP process up) but all jobs fail.
- Container logs show `claude` errors immediately after redeploy.
- No Coolify volume mount for `~/.claude/`.

**Phase to address:**
Phase 1 (de-risk spike) must validate the persistence strategy. Phase 5 (Coolify deploy) must implement the volume mount and startup probe.

---

### Pitfall 9: Zombie `claude` Processes Accumulating in the Container

**What goes wrong:**
`claude -p` is spawned via `subprocess` for each audit. If the audit times out, the Python code raises a `TimeoutError` and moves on, but the `claude` subprocess is not explicitly killed. Over hours, the container accumulates dozens of orphan `claude` processes each holding ~250–500 MB RAM, eventually OOMing the container.

**Why it happens:**
`asyncio.create_subprocess_exec` + `wait_for` timeout cancels the Python coroutine but does not send SIGTERM to the child process. Global rule 23 documents the real-world incident (34 orphan claudes + 90 uv/uvx procs = 8 GB). This is a known failure mode in this exact operator's environment.

**How to avoid:**
- Use `async with asyncio.timeout(300): await proc.communicate()` — on timeout, explicitly `proc.kill()` and `await proc.wait()` in the `except TimeoutError` handler.
- Use a `try/finally` block that always calls `proc.kill()` if `proc.returncode is None`.
- Add a periodic reaper (every 5 minutes) that checks for `claude` child processes older than the max audit TTL and kills them.
- Monitor container process count on `/health` — alert if `claude` process count exceeds `max_concurrent_audits + 1`.

**Warning signs:**
- Container memory grows monotonically between restarts.
- `ps aux | grep claude` inside the container shows PIDs with no associated job in `running` state.
- Container gets OOM-killed without a corresponding large single request.

**Phase to address:**
Phase 3 (FastAPI service + worker), Phase 5 (Coolify deploy monitoring).

---

### Pitfall 10: Healthcheck on `/health` Only — Route-Level Breakage Invisible to Coolify

**What goes wrong:**
`/health` returns 200. Coolify marks the container healthy. But `POST /audit` returns 502 because the DB connection pool is exhausted, or `GET /audit/{id}` returns 500 because a migration was missed, or all `claude -p` calls fail silently. Consumer apps experience failures; Coolify never triggers a restart.

**Why it happens:**
Global rule 14 already documents this ("`/health` 200 only proves the process is up; route-level breakage only shows on the real routes"). The tendency is to ship the minimum health endpoint and call it done.

**How to avoid:**
- `/health` must check: (1) Postgres connectivity (a `SELECT 1`), (2) `claude_auth_valid` (lightweight auth probe), (3) worker process alive (check worker heartbeat timestamp in DB < 60 s old), (4) current job queue depth and active count.
- Return structured JSON: `{"status": "ok|degraded|down", "postgres": bool, "claude_auth": bool, "worker_alive": bool, "queue_depth": int, "active_jobs": int}`.
- Coolify startup probe and liveness probe should use `/health`; a separate readiness check endpoint or a more specific probe should validate the DB before taking traffic.
- Post-deploy smoke test script (per global rule 14): hit `/health`, then `POST /audit` with a known-good URL, poll until `completed`, verify score is a number in 0–100.

**Warning signs:**
- `/health` only checks that the process responds, not that dependencies are reachable.
- No DB `SELECT 1` in the health check.
- No smoke test after deploy.

**Phase to address:**
Phase 5 (Coolify deploy). Define the health contract in Phase 3 alongside the FastAPI service design.

---

### Pitfall 11: Secrets Baked into the Container Image

**What goes wrong:**
`DATABASE_URL`, API keys, or the Claude auth token are written into the `Dockerfile` or `docker-compose.yml` as `ENV` or `ARG` values and committed to the repo. The image is pushed to a container registry. The secrets are now in the image layer history and the git history — both are permanent.

**Why it happens:**
The fastest path to "it works" is hardcoding. CONCERNS.md already flags this (global rule 17: `DATABASE_URL` lives in Coolify env, never in repo).

**How to avoid:**
- `DATABASE_URL`, `CLAUDE_AUTH_TOKEN` (if any), and all credentials are injected only via Coolify environment variables at runtime.
- Claude auth state is mounted as a Coolify persistent volume, not baked into the image.
- `.dockerignore` must exclude `.env`, `~/.claude/`, and any secrets files.
- `docker history <image>` should show no secret-shaped strings in `ENV` layers — verify in CI.

**Warning signs:**
- Any `ENV DATABASE_URL=...` in `Dockerfile`.
- `.env` file not in `.dockerignore`.
- `ARG` variables used to pass secrets during `docker build`.

**Phase to address:**
Phase 4 (containerization). Define `.dockerignore` and Coolify env injection before the first image build.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Using `BackgroundTasks` for audits | Zero infrastructure, ships fast | Jobs lost on redeploy; no retry; no status persistence | Never — audits take minutes, not milliseconds |
| Skipping `run_in_executor` for sync scrapers | Simpler code | Blocks event loop; all requests stall during audits | Never — all scrapers are blocking I/O |
| Single-point SSRF check before request | Simple implementation | Bypassed by DNS rebinding | Never in a networked service |
| No response-size cap | Simpler code | One hostile URL OOMs the container | Never once `/audit` is exposed |
| Broad `except Exception: pass` in scrapers (already in codebase) | Silences noise | Hides real failures; partial results look complete | Never — at minimum log the exception |
| Pinning `claude` auth in image layer | Easy first deploy | Secrets in image history; breaks on token refresh | Never for production |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `claude -p` subprocess | Assuming non-interactive mode is always non-interactive | Test in a container with no TTY; capture stderr for auth prompts; add hard timeout |
| `claude -p` rate limits | Treating subscription as "unlimited" | Subscription has concurrent session and usage limits; test with max_concurrent_audits=1 first, raise only after measuring |
| Coolify Postgres | Connecting before migration runs at startup | Use Alembic with a startup migration check; handle `OperationalError` gracefully on `/health` |
| Coolify persistent volumes | Forgetting to declare volume in Coolify service config | Test full destroy + redeploy cycle to verify volume survives |
| `requests` inside `async def` | Direct call without executor | Always wrap with `run_in_executor`; never call blocking I/O in async context |
| Sitemap XML `loc` URLs | Trusting them as safe | Apply full SSRF guard to every `loc` URL — they are attacker-controlled if the target site is adversarial |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Serial scraper calls inside audit | Audit takes 3–5 min per site | Bounded `ThreadPoolExecutor` for concurrent scrapes | Every audit at current codebase baseline |
| Unbounded `claude -p` parallelism | Container OOM; rate limit spikes | `asyncio.Semaphore(max_concurrent)` on worker | 3+ simultaneous audits |
| Full-page HTML loaded into RAM per scraper call | OOM on hostile/large pages | `stream=True` + byte cap in `http.py` | First time a >50 MB page is fetched |
| DB connection pool exhaustion under concurrent jobs | 500s on status polls | Set explicit `pool_size` and `max_overflow` in SQLAlchemy; expose pool stats on `/health` | >10 concurrent API consumers |
| No job TTL reaper | DB fills with `running` rows from crashed jobs | Reaper cron or background loop resetting stale jobs | First container OOM or SIGKILL |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| No SSRF guard on `fetch_page.py` | Container fetches cloud metadata / internal services | DNS-pinning SSRF guard in `http.py` before any URL is accepted via API |
| No response-size cap | OOM kills container; kills all in-flight jobs | `stream=True` + 5 MB hard cap in `http.py` |
| No auth on `/audit` endpoint | Any internet client can trigger expensive audits | Titanium licensing API key check on every `/audit` route (global rule 16) |
| Secrets in image layers | Leaked credentials in registry | Coolify env injection only; verify with `docker history` |
| Sitemap `loc` URLs trusted without SSRF check | SSRF via attacker-controlled XML | Apply `http.py` guard to every `loc` before fetch |
| `claude -p` output returned verbatim | Prompt injection if scorer output contains attacker-crafted content | Validate/parse score output against expected schema; reject malformed responses |

---

## "Looks Done But Isn't" Checklist

- [ ] **SSRF guard:** Only scheme check (`http`/`https`) — verify DNS resolution + IP range validation + redirect re-validation is in place
- [ ] **Response-size cap:** Timeout is set but body size is not capped — verify `stream=True` + byte counter
- [ ] **Job durability:** `BackgroundTasks` used but not a persistent worker — verify jobs survive container restart
- [ ] **Claude auth persistence:** Works on first deploy — verify auth survives full image replacement (destroy + redeploy cycle)
- [ ] **Event loop blocking:** Scrapers imported and called — verify all calls are wrapped in `run_in_executor`
- [ ] **Concurrency cap:** Jobs run — verify semaphore limit is in place and tested with 5+ simultaneous POSTs
- [ ] **Zombie process reaper:** Timeout fires — verify `claude` child process is explicitly killed on timeout
- [ ] **Health endpoint depth:** `/health` returns 200 — verify it checks Postgres, claude auth, and worker liveness
- [ ] **Secrets outside image:** Container starts — verify `docker history` shows no `DATABASE_URL` or auth tokens in ENV layers
- [ ] **Stuck-job reaper:** Jobs are written to DB — verify `heartbeat_at` reaper resets crashed jobs

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Auth token expired in prod container | MEDIUM | SSH into Coolify container; re-auth `claude`; copy token to persistent volume; restart |
| SSRF exploit fired before guard was in place | HIGH | Rotate all credentials reachable from the container; audit Cloudflare/Coolify logs for outbound requests to 169.254.x.x or RFC-1918; deploy patched image immediately |
| Jobs stuck in `running` after OOM restart | LOW | SQL: `UPDATE jobs SET status='queued', locked_until=NULL WHERE status='running' AND heartbeat_at < NOW() - INTERVAL '10m'`; restart worker |
| Container OOM from decompression bomb | MEDIUM | Add memory limit to Coolify service config; add size cap to `http.py`; redeploy |
| Zombie claude processes filling RAM | MEDIUM | `docker exec <container> pkill -9 claude`; add reaper to worker; redeploy with fix |
| Secrets found in image layer history | HIGH | Invalidate all exposed credentials; rebuild image from scratch without secrets in layers; push new image; rotate in Coolify env |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Headless `claude -p` auth hangs | Phase 1: De-risk spike | `claude -p "echo ok"` returns within 30s inside a container with no TTY |
| SSRF private-IP access | Phase 2: SSRF hardening | `POST /audit {"url": "http://169.254.169.254/"}` returns 400 before any network call |
| DNS rebinding bypass | Phase 2: SSRF hardening | Custom DNS-pinning transport adapter in `http.py`; unit test with mock resolver |
| Response-size bomb | Phase 2: SSRF hardening | `POST /audit {"url": "<100MB-page>"}` returns 413 within timeout; container RAM unchanged |
| `BackgroundTasks` job loss on redeploy | Phase 3: FastAPI + job worker | Redeploy container mid-job; job resumes from `queued` on new container startup |
| Event loop blocking by sync scrapers | Phase 3: FastAPI + job worker | `/audit/{id}` status poll returns <100ms during active audit |
| Concurrency cap missing | Phase 3: FastAPI + job worker | 10 simultaneous POSTs results in 7 queued, 3 active; container RAM stable |
| Zombie `claude` processes | Phase 3: FastAPI + job worker | Timeout fires; `ps aux` shows no orphaned `claude` processes 60s later |
| Secrets in image layers | Phase 4: Containerization | `docker history <image>` shows no `DATABASE_URL` or tokens |
| Claude auth not persisted | Phase 5: Coolify deploy | Full destroy + redeploy cycle; `/health` reports `claude_auth: true` after fresh container start |
| Shallow healthcheck | Phase 5: Coolify deploy | `/health` JSON includes `postgres`, `claude_auth`, `worker_alive`, `queue_depth` all green |

---

## Sources

- CONCERNS.md (codebase audit, 2026-06-01) — direct evidence for SSRF, response-size, blocking I/O, JSON-racy writes
- PROJECT.md — explicit de-risk spike requirement for headless `claude -p`; confirms subscription-not-API-key constraint
- Global rule 23 (`~/.claude/CLAUDE.md`) — real incident: 34 orphan `claude` + 90 `uv`/`uvx` procs = 8 GB (zombie process pattern is documented as a known operational failure mode in this environment)
- Global rule 14 — `/health`-only verification is insufficient; smoke-test all touched routes post-deploy
- FastAPI BackgroundTasks docs — fire-and-forget, no persistence, no restart recovery (domain knowledge, HIGH confidence)
- DNS rebinding SSRF bypass — documented attack class; standard mitigation is IP-pinning at socket level (HIGH confidence)

---
*Pitfalls research for: geo-api (FastAPI + headless claude -p + SSRF-exposed URL fetcher + Coolify)*
*Researched: 2026-06-01*
