/**
 * URL utilities — stdlib only, no node: imports (D-04 Anti-Pattern guard).
 * Uses global `URL` (available in Node 10+, Bun, browsers).
 */

/**
 * Normalize a URL string.
 * Returns { url, errors } — never throws for bad input (D-06 result-accumulation).
 */
export function normalizeUrl(input: string): { url: string; errors: string[] } {
  const errors: string[] = [];
  try {
    const parsed = new URL(input);
    return { url: parsed.href, errors };
  } catch {
    errors.push(`Invalid URL: "${input}" — could not be parsed by the URL constructor`);
    return { url: "", errors };
  }
}
