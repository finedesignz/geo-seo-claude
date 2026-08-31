#!/usr/bin/env bash
#
# deploy-verify.sh — live post-deploy smoke test for @geo/api (D-08, DEPLOY-04).
#
# RUN BY THE VERIFIER *AFTER* A LIVE COOLIFY DEPLOY (Phase 6 plan 03) — NOT in CI.
# There is no live URL at author time; this is the artifact plan 03 consumes.
#
# Per ~/.claude rule 14: never claim "shipped + verified" on /healthz alone. This
# script exercises the real auth'd audit round-trip end to end.
#
# Inputs (env — NOTHING hardcoded; fails fast if a required var is unset):
#   GEO_API_BASE   required  deployed API origin, e.g. https://geo-api.titaniumlabs.us
#   GEO_API_TOKEN  required  ONE bearer from GEO_API_KEYS (the token part BEFORE the ':')
#   AUDIT_URL      optional  benign public URL to audit (default https://example.com)
#
# Sequence:
#   1. poll GET /healthz  → 200 {"db":"ok"}        (bounded, backoff)
#   2. GET /openapi.json  → 200 + has "openapi"    (rule 21 reachability)
#      GET /docs          → 200                     (rule 21 Scalar UI)
#   3. POST /audit NO auth → 401                     (bearer enforced, T-06-06)
#   4. POST /audit Bearer  → 200 {"job_id":...}      (capture job_id)
#   5. poll GET /audit/{job_id} Bearer → done|failed (print final status+score)
#
# Exit 0 only if every expectation holds; non-zero (with a clear message) otherwise.
# Dependency-light: curl + (bun for JSON parse, else grep/sed fallback).

set -euo pipefail

# ---- config -----------------------------------------------------------------
GEO_API_BASE="${GEO_API_BASE:-}"
GEO_API_TOKEN="${GEO_API_TOKEN:-}"
AUDIT_URL="${AUDIT_URL:-https://example.com}"

HEALTH_TRIES="${HEALTH_TRIES:-30}"      # ×2s ≈ 60s
AUDIT_TRIES="${AUDIT_TRIES:-60}"        # ×2s ≈ 120s
SLEEP_S="${SLEEP_S:-2}"

# ---- helpers ----------------------------------------------------------------
die()  { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
info() { printf '==> %s\n' "$1"; }
pass() { printf 'PASS: %s\n' "$1"; }

# Extract a top-level string field from a JSON blob on stdin.
# Prefers bun (real JSON.parse); falls back to grep/sed.
json_field() {
  local field="$1" body="$2"
  if command -v bun >/dev/null 2>&1; then
    printf '%s' "$body" | bun -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        try { const o=JSON.parse(s); const v=o[process.argv[1]];
          process.stdout.write(v==null?"":String(v)); }
        catch { process.stdout.write(""); }
      });' "$field"
  else
    printf '%s' "$body" \
      | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
      | head -n1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
  fi
}

# HTTP status code only (no body), for a given method/url/optional bearer.
http_code() {
  local method="$1" url="$2" auth="${3:-}"
  if [ -n "$auth" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer ${auth}" \
      -H 'Content-Type: application/json' \
      --data "{\"url\":\"${AUDIT_URL}\"}" "$url"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "$method" \
      -H 'Content-Type: application/json' \
      --data "{\"url\":\"${AUDIT_URL}\"}" "$url"
  fi
}

# ---- preflight --------------------------------------------------------------
[ -n "$GEO_API_BASE" ]  || die "GEO_API_BASE is unset (e.g. https://geo-api.titaniumlabs.us)"
[ -n "$GEO_API_TOKEN" ] || die "GEO_API_TOKEN is unset (a GEO_API_KEYS bearer, token part before ':')"
GEO_API_BASE="${GEO_API_BASE%/}"   # strip trailing slash
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"

info "Target: ${GEO_API_BASE}  (audit url: ${AUDIT_URL})"

# ---- 1. healthz poll --------------------------------------------------------
info "1/5 polling ${GEO_API_BASE}/healthz (up to $((HEALTH_TRIES * SLEEP_S))s)"
healthy=0
for i in $(seq 1 "$HEALTH_TRIES"); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${GEO_API_BASE}/healthz" || echo 000)"
  if [ "$code" = "200" ]; then healthy=1; break; fi
  printf '    try %s/%s → HTTP %s\n' "$i" "$HEALTH_TRIES" "$code"
  sleep "$SLEEP_S"
done
[ "$healthy" = "1" ] || die "/healthz never returned 200"
hbody="$(curl -s "${GEO_API_BASE}/healthz")"
case "$hbody" in
  *'"db":"ok"'*|*'"db": "ok"'*) pass "/healthz 200 db:ok" ;;
  *) die "/healthz 200 but db not ok: ${hbody}" ;;
esac

# ---- 2. public doc probes (rule 21) -----------------------------------------
info "2/5 doc reachability probes"
ojson="$(curl -fsS "${GEO_API_BASE}/openapi.json")" || die "GET /openapi.json not 2xx"
case "$ojson" in *'"openapi"'*) pass "/openapi.json 200 + has openapi key" ;;
  *) die "/openapi.json missing \"openapi\" key" ;; esac
dcode="$(curl -s -o /dev/null -w '%{http_code}' "${GEO_API_BASE}/docs" || echo 000)"
[ "$dcode" = "200" ] || die "/docs expected 200, got ${dcode}"
pass "/docs 200"

# ---- 3. negative auth probe (T-06-06) ---------------------------------------
info "3/5 unauth POST /audit must be 401"
ncode="$(http_code POST "${GEO_API_BASE}/audit")"
[ "$ncode" = "401" ] || die "unauth POST /audit expected 401, got ${ncode}"
pass "unauth POST /audit → 401"

# ---- 4. authed submit -------------------------------------------------------
info "4/5 authed POST /audit"
sbody="$(curl -s -X POST "${GEO_API_BASE}/audit" \
  -H "Authorization: Bearer ${GEO_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{\"url\":\"${AUDIT_URL}\"}")"
job_id="$(json_field job_id "$sbody")"
[ -n "$job_id" ] || die "POST /audit returned no job_id: ${sbody}"
pass "submitted job_id=${job_id}"

# ---- 5. poll to terminal ----------------------------------------------------
info "5/5 polling GET /audit/${job_id} (up to $((AUDIT_TRIES * SLEEP_S))s)"
for i in $(seq 1 "$AUDIT_TRIES"); do
  jbody="$(curl -s "${GEO_API_BASE}/audit/${job_id}" \
    -H "Authorization: Bearer ${GEO_API_TOKEN}")"
  status="$(json_field status "$jbody")"
  case "$status" in
    done)
      pass "audit done: ${jbody}"
      printf '\nSMOKE PASSED — %s reachable, auth enforced, audit round-trip OK.\n' "$GEO_API_BASE"
      exit 0
      ;;
    failed)
      die "audit failed: ${jbody}"
      ;;
    queued|running|"")
      printf '    try %s/%s → status=%s\n' "$i" "$AUDIT_TRIES" "${status:-?}"
      sleep "$SLEEP_S"
      ;;
    *)
      die "unexpected status '${status}': ${jbody}"
      ;;
  esac
done
die "audit ${job_id} never reached done|failed within timeout"
