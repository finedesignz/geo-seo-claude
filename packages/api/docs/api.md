# @geo/api API

> Generated from `/openapi.json` (OpenAPI 3.1.0). Do not edit by hand.
> Regenerate: `bun run --cwd packages/api gen-docs`

**Version:** 0.1.0

## Security Schemes

| Name | Type | Scheme |
| ---- | ---- | ------ |
| BearerAuth | http | bearer |

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| POST | `/audit` | BearerAuth | Submit a URL for a GEO audit |
| GET | `/audit/{job_id}` | BearerAuth | Poll the status of a submitted audit |
| GET | `/audits` | BearerAuth | List the caller's audit history (paginated) |
| GET | `/healthz` | public | Deep liveness probe (DB SELECT 1) |
