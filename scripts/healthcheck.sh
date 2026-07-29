#!/bin/sh
#
# healthcheck.sh — role-aware Docker HEALTHCHECK dispatcher.
#
# One shared image serves all GEO_ROLE values (api/worker/cron), so the
# HEALTHCHECK instruction can't hardcode a single probe. Dispatch here instead:
#   worker -> exec scripts/worker-healthcheck.sh (heartbeat freshness)
#   api    -> HTTP GET localhost:${PORT:-8080}/healthz, expect 200
#   cron / anything else -> exit 0 (one-shot job has no meaningful liveness
#     signal between runs; don't fail a role we don't check)
set -eu

case "${GEO_ROLE:-api}" in
  worker)
    # bash, not sh: worker-healthcheck.sh uses `set -o pipefail`, which dash
    # (this image's /bin/sh) rejects with "Illegal option -o pipefail" -> exit 2
    # -> permanently unhealthy -> restart loop.
    exec bash "$(dirname "$0")/worker-healthcheck.sh"
    ;;
  api)
    port="${PORT:-8080}"
    if command -v curl >/dev/null 2>&1; then
      curl -fsS "http://localhost:${port}/healthz" >/dev/null
    else
      wget -q -O /dev/null "http://localhost:${port}/healthz"
    fi
    ;;
  *)
    exit 0
    ;;
esac
