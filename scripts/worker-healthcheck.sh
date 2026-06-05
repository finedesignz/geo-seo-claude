#!/usr/bin/env bash
#
# worker-healthcheck.sh — liveness probe for the @geo/worker container role (D-06).
#
# The worker exposes no HTTP port; runWorker() writes the current epoch-ms to
# WORKER_HEARTBEAT_FILE on every poll-loop iteration. This script is the
# per-resource health command in Coolify: exit 0 = fresh, exit 1 = stale/missing.
#
# Env:
#   WORKER_HEARTBEAT_FILE     path to the heartbeat file (default /tmp/worker-heartbeat)
#   WORKER_HEARTBEAT_MAX_AGE_S max heartbeat age in seconds before unhealthy (default 60)
set -euo pipefail

HEARTBEAT_FILE="${WORKER_HEARTBEAT_FILE:-/tmp/worker-heartbeat}"
MAX_AGE_S="${WORKER_HEARTBEAT_MAX_AGE_S:-60}"

if [ ! -f "$HEARTBEAT_FILE" ]; then
  echo "worker-healthcheck: heartbeat file missing: $HEARTBEAT_FILE" >&2
  exit 1
fi

now="$(date +%s)"
mtime="$(stat -c %Y "$HEARTBEAT_FILE")"
age=$(( now - mtime ))

if [ "$age" -ge "$MAX_AGE_S" ]; then
  echo "worker-healthcheck: heartbeat stale (${age}s >= ${MAX_AGE_S}s)" >&2
  exit 1
fi

exit 0
