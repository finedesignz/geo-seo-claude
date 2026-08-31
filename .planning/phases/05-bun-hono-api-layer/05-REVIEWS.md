---
phase: 5
reviewers: [gemini, codex]
reviewed_at: 2026-06-02
plans_reviewed: [05-00-PLAN.md, 05-01-PLAN.md, 05-02-PLAN.md]
self_skipped: claude (CLAUDE_CODE_ENTRYPOINT=cli)
---

# Cross-AI Plan Review — Phase 5 (Bun+Hono API Layer)

## Gemini Review

# Phase 5 (Bun+Hono API Layer) Plan Review

## Summary
Comprehensive 3-wave plan to deliver an authenticated Bun+Hono API for GEO audits. It leverages the existing `@geo/db` and `@geo/fetch` infrastructure while introducing a new `packages/api` package. The strategy correctly sequences database migrations, SSRF utility extensions, and API implementation.

## Strengths
- **Surgical Scaffolding:** Excellent attention to detail on `zod` v3 alignment (D-14) to avoid workspace dependency drift.
- **Security-First:** Double-gate SSRF checks (submit-time validation + fire-time re-validation) for webhooks is robust against TOCTOU.
- **Efficiency:** Reuses existing PGlite test infrastructure and `@geo/fetch` logic, minimizing logic duplication.
- **OpenAPI Integration:** Uses `@hono/zod-openapi` as the single source of truth for both validation and documentation, adhering to Rule 21.

## Concerns
- **HIGH: Cross-Consumer Dedup vs. Ownership Leak/Block:** 
  - **The Conflict:** D-04/API-04 specifies cross-consumer dedup (returning an existing `job_id`), but D-05/API-02 enforces strict consumer ownership for polling.
  - **The Bug:** If Consumer A audits `example.com` and gets `job_123`, and Consumer B then audits the same URL, they will be given `job_123` via dedup. However, Consumer B’s `GET /audit/job_123` will return **404** because they do not "own" Consumer A's job record.
- **MEDIUM: Migration Side Effects:** Migration `0002` adds a nullable `consumer_id`. Existing jobs will have `NULL`. `listJobs` logic `($3::text IS NULL OR consumer_id = $3)` will return legacy jobs to *every* consumer if the API doesn't strictly pass a `consumerId`.
- **LOW: Webhook Retries in Worker:** The plan puts webhook delivery in the worker pipeline. While non-blocking, if a callback URL is slow or retrying, it could consume worker "slots" or delay the next job claim if not handled carefully (though `deliverWebhook` is async and not awaited in a way that blocks the loop).

## Suggestions
1. **Fix Dedup Ownership:** Either:
   - **Per-Consumer Dedup:** Change `findRecentByUrlHash` to accept `consumerId`. This is the safest and most tenant-isolated approach.
   - **Shared Access:** Modify `getJob` to allow access if `job.consumerId` matches OR if a new "access" table/column grants the caller rights to that result. (Recommendation: Stick to Per-Consumer Dedup for MVP).
2. **Migration Cleanup:** Consider updating existing rows in `0002_add_consumer_id.sql` to a 'legacy' or 'system' ID if those jobs should be hidden from new consumers.
3. **Webhook Visibility:** Add a `webhook_status` (e.g., `pending`, `delivered`, `failed`) to the `audits` table in a future wave to help debug delivery issues without scanning worker logs.

## Risk Assessment
- **Risk:** **LOW-MEDIUM**
- **Rationale:** The logic conflict between cross-consumer dedup and ownership checks is the only significant blocker. The rest of the plan is technically sound and follows established patterns.

## Requirement Coverage Check
- [x] **API-01 (Submit):** Covered in 05-01 Task 2.
- [x] **API-02 (Poll):** Covered in 05-02 Task 1.
- [x] **API-03 (History):** Covered in 05-02 Task 1 (noting ownership scoping).
- [x] **API-04 (Dedup):** Covered in 05-01 Task 2 (Conflict noted above).
- [x] **API-05 (Auth):** Covered in 05-01 Task 1.
- [x] **API-06 (Health):** Covered in 05-02 Task 1.
- [x] **API-07 (OpenAPI):** Covered in 05-00/05-02.
- [x] **API-08 (Webhook):** Covered in 05-00/05-02 (SSRF checks included).

---

## Codex Review

## Summary
Plans are mostly coherent and likely achieve Phase 5, with good dependency sequencing: schema/SSRF/scaffold first, submit/auth second, reads/docs/webhook last. Main risks are unresolved requirement conflict around unauthenticated access, webhook coupling/scope creep, and several security/edge-case gaps in dedup, SSRF validation, and auth parsing.

## Strengths
- **HIGH:** Correct wave ordering: `consumer_id`, SSRF POST support, and API scaffold unblock later slices cleanly.
- **HIGH:** Cross-tenant read scoping is explicit: `GET /audit/{id}` uses 404 for not-owned, `GET /audits` passes `consumerId`.
- **HIGH:** SSRF is treated as a shared primitive and checked both at submit and fire time.
- **MEDIUM:** Tests are concrete and behavior-focused: auth, dedup skip-failed, PGlite DAL, health 200/503, webhook non-fatal.
- **MEDIUM:** Zod/OpenAPI single-source approach avoids spec drift if version compatibility is handled.

## Concerns
- **HIGH:** Auth requirement conflict. Roadmap says “unauthenticated request to any endpoint returns 401”; plans exempt `/healthz`, `/openapi.json`, `/docs`. Reconcile before implementation.
- **HIGH:** Dedup appears cross-consumer by `url_hash`. Returning another consumer’s existing `job_id` can leak existence and may later fail polling due ownership 404. Either scope dedup by `consumer_id` or define shared-result semantics.
- **HIGH:** Webhook delivery in worker is scope creep for API phase and touches terminal failure paths. Good plan, but it raises regression risk in worker pipeline.
- **MEDIUM:** `validateUrlHost` “no network” is misleading if DNS resolution occurs. It means no HTTP request. Be precise in tests/docs.
- **MEDIUM:** SSRF plan needs explicit redirect behavior for webhook POST. `createSafeRequester` must validate every redirect target or disable redirects.
- **MEDIUM:** Callback POST response-size/body caps are not mentioned. Even webhook delivery can be abused if responses are large or compressed.
- **MEDIUM:** `crypto.timingSafeEqual` over variable-length tokens needs length-safe handling; otherwise it can throw or still leak lookup shape.
- **MEDIUM:** `GET /audits` response may expose full `callbackUrl`, errors, or internal fields unless response DTO is explicitly narrowed.
- **LOW:** `consumer_id` nullable is migration-friendly, but tests should cover null legacy rows not appearing in authenticated history.
- **LOW:** Docs generation command is vague; plan should name the exact script and fail CI if generated docs drift.

## Suggestions
- Decide auth policy now: public health/docs or strict 401 everywhere. Update roadmap/context/tests to match.
- Make dedup consumer-scoped unless shared cached jobs are intentionally readable by all consumers. If shared, return a consumer-owned alias/job row.
- Add explicit webhook rules: no redirects or SSRF-check every redirect, max response bytes, timeout, retry backoff, allowed content ignored.
- Define response DTOs for poll/history; do not return raw `AuditJob`.
- Add tests for malformed `GEO_API_KEYS`, duplicate tokens, token containing colon/comma, lowercase `bearer`, and variable token lengths.
- Add tests for callback URL DNS rebinding at fire time, IPv6 private/link-local, metadata IPs, and redirect-to-private.
- Consider awaiting webhook delivery only through a bounded helper if current fire-and-forget risks process exit before send.

## Overall Risk
**MEDIUM-HIGH.** The plan is strong structurally, but the auth/dedup semantics and webhook SSRF edge cases need tightening before execution.

---

## Consensus Summary

### Agreed Concerns (folded / decided)
- **[HIGH — both] Cross-consumer dedup vs ownership conflict.** Dedup by `url_hash` returns another consumer's `job_id`, but ownership-scoped `GET /audit/{id}` then 404s it (broken + existence leak). → FOLD: make dedup **consumer-scoped** — `findRecentByUrlHash(hash, ttl, consumer_id)` dedups against the caller's OWN recent jobs only (tenant-isolated; both reviewers' recommended MVP fix).
- **[HIGH — codex] Auth-policy spec conflict.** ROADMAP success criterion #4 ("unauthenticated request to ANY endpoint returns 401") vs plans exempting `/healthz`,`/openapi.json`,`/docs`. → DECISION REQUIRED (surfaced to operator; see below).
- **[MED] Webhook SSRF completeness.** `createSafeRequester` POST must apply Phase-2 protections too: no redirects (or re-validate every hop), response-size/decompression cap, timeout + bounded backoff. → FOLD into D-12.
- **[MED] Response DTOs.** Poll/history must NOT return raw `AuditJob` (exclude `callback_url`, `lease_token`, `attempts`, internal cols). → FOLD as D-15.
- **[MED] Auth parsing robustness.** Tests for malformed `GEO_API_KEYS`, token w/ colon/comma, lowercase `bearer`, length-safe compare (timingSafeEqual). → FOLD into D-03 tests.
- **[MED/LOW] Legacy null consumer_id rows** must never appear in an authenticated consumer's history — scoped query uses `consumer_id = $1` (NOT a NULL-permissive OR). → FOLD into D-11.
- **[MED] validateUrlHost wording** — "no HTTP request" (DNS resolution still occurs). → clarify in D-12.

### Divergent
- Overall risk: gemini LOW-MEDIUM, codex MEDIUM-HIGH. Converges to LOW after the dedup fix + auth decision.
