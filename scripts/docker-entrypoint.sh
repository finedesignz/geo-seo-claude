#!/bin/sh
# Role dispatch for the single geo-seo-claude image.
#
# WHY: Coolify's Dockerfile build pack does NOT honor a per-resource custom
# start-command override (verified on Coolify 4.1.1 — the worker resource ran the
# image's default CMD). So the original "role by start command" design (D-03) does
# not work there. The role is therefore selected by the GEO_ROLE env var instead,
# set per Coolify resource:
#   GEO_ROLE=api    (default) -> the Bun+Hono HTTP API   (PORT, default 8080)
#   GEO_ROLE=worker           -> the background audit worker (no port; SIGTERM drain)
#   GEO_ROLE=cron             -> one-shot scheduled re-audit (exits when done)
#
# `exec` makes the chosen Bun process PID 1 so it receives SIGTERM directly (D-09).
# Migrations still run as a one-shot (`bun packages/db/scripts/migrate.ts`) via the
# Coolify pre-deployment command / scheduled task and do not pass through here.
set -e
case "${GEO_ROLE:-api}" in
  worker) exec bun packages/worker/dist/main.js ;;
  cron)   exec bun packages/cron/dist/main.js ;;
  api|*)  exec bun packages/api/dist/main.js ;;
esac
