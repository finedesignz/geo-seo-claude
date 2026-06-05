/**
 * Pure one-shot cron loop (D-1, D-8).
 *
 * For each configured URL, POST `${baseUrl}/audit` with a Bearer token and JSON
 * body `{ url }`. Per-URL failures are captured and the loop CONTINUES (Pitfall 3 —
 * one bad URL must not abort the batch). Returns a summary the caller uses to pick
 * an exit code.
 *
 * Security (T-07-01 / Pitfall 5): the Authorization header value (CRON_API_TOKEN)
 * is NEVER logged. Logs carry only url + job_id/status.
 *
 * fetch is injected (default = global fetch) so tests can pass the in-process Hono
 * app's `app.request` with zero network (D-7).
 */

export interface CronDeps {
  /** geo-api base URL (trailing slash already stripped by assertEnv). */
  baseUrl: string;
  /** Bearer token for the `cron` consumer. NEVER logged. */
  token: string;
  /** Validated audit-target URLs. */
  urls: string[];
  /** Injectable fetch; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CronResult {
  url: string;
  ok: boolean;
  status?: number;
  jobId?: string;
  error?: string;
}

export interface CronSummary {
  total: number;
  succeeded: number;
  failed: number;
  results: CronResult[];
}

export async function runCron(deps: CronDeps): Promise<CronSummary> {
  const doFetch = deps.fetchImpl ?? fetch;
  const results: CronResult[] = [];

  for (const url of deps.urls) {
    try {
      const res = await doFetch(`${deps.baseUrl}/audit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header value (token) is intentionally never logged below.
          authorization: `Bearer ${deps.token}`,
        },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        results.push({ url, ok: false, status: res.status, error: `http_${res.status}` });
        console.error(`[cron] FAILED ${url}: http_${res.status}`);
        continue;
      }

      const json = (await res.json()) as { job_id?: string };
      const jobId = json.job_id;
      results.push({ url, ok: true, status: res.status, jobId });
      console.log(`[cron] enqueued ${url} -> ${jobId ?? "(no job_id)"}`);
    } catch (err) {
      // Never include the request init / headers in the log line.
      results.push({ url, ok: false, error: String(err) });
      console.error(`[cron] FAILED ${url}: ${err}`);
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return {
    total: results.length,
    succeeded: results.length - failed,
    failed,
    results,
  };
}
