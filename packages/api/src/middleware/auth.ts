/**
 * @geo/api — bearer auth middleware + parseApiKeys (API-05, D-03).
 *
 * Auth model (OPERATOR DECISION 2026-06-04):
 *   - Every DATA route requires `Authorization: Bearer <token>`; the token is
 *     looked up in a token→consumer_id map built from GEO_API_KEYS at startup.
 *   - EXEMPT (public, no auth): /healthz, /openapi.json, /docs.
 *   - On a valid token the resolved consumer_id is attached to the request
 *     context via c.set('consumer_id', ...).
 *   - On missing/invalid token → 401 { error:'unauthorized', message } with a
 *     WWW-Authenticate header.
 *
 * Security notes (T-05-01-02):
 *   - Token comparison uses crypto.timingSafeEqual to avoid timing leaks. We
 *     guard buffer length first (a length mismatch returns 401 rather than
 *     throwing from timingSafeEqual). We hash both sides to a fixed-length
 *     digest so the equal-length precondition always holds and the comparison
 *     itself is constant-time regardless of token length.
 *   - The Authorization header is NEVER logged.
 *
 * Parsing robustness (D-03):
 *   - The bearer scheme match is case-insensitive (`bearer`/`Bearer`/`BEARER`).
 *   - parseApiKeys splits each pair on the FIRST `:` so tokens containing `:`
 *     survive. Pairs are comma-separated; backslash escaping (`\,`, `\:`, `\\`)
 *     lets a token contain a literal comma or colon.
 *   - Fail-fast: parseApiKeys throws (mirroring @geo/db getSql) when
 *     GEO_API_KEYS is missing/empty or parses to an empty map.
 */

import { createMiddleware } from "hono/factory";
import { createHash, timingSafeEqual } from "node:crypto";

/** Paths reachable without a bearer token (rule-21 docs surface + liveness). */
export const EXEMPT = new Set(["/healthz", "/openapi.json", "/docs"]);

/**
 * Parse the GEO_API_KEYS env value into a token→consumer_id map.
 *
 * Format: comma-separated `token:consumer_id` pairs. Each pair is split on the
 * FIRST `:` (tokens may contain `:`). Backslash escaping is supported so a token
 * may contain a literal `,` (`\,`) or `:` (`\:`); `\\` is a literal backslash.
 *
 * @throws if `raw` is missing/empty or no valid pairs are found (fail-fast).
 */
export function parseApiKeys(raw: string | undefined): Map<string, string> {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "@geo/api: GEO_API_KEYS is required but not set. " +
        "Set GEO_API_KEYS in your environment (see .env.example). " +
        "Format: token1:consumer1,token2:consumer2",
    );
  }

  const map = new Map<string, string>();

  for (const rawPair of splitEscaped(raw, ",")) {
    const pair = unescape(rawPair).trim();
    if (pair === "") continue;
    // Split on the FIRST unescaped ':' — but unescape() already collapsed
    // escapes, so we must find the colon BEFORE unescaping. Re-derive from the
    // escaped form to keep escaped ':' inside the token.
    const idx = firstUnescapedColon(rawPair.trim());
    if (idx < 0) continue;
    const token = unescape(rawPair.trim().slice(0, idx)).trim();
    const consumerId = unescape(rawPair.trim().slice(idx + 1)).trim();
    if (token !== "" && consumerId !== "") {
      map.set(token, consumerId);
    }
  }

  if (map.size === 0) {
    throw new Error(
      "@geo/api: GEO_API_KEYS parsed to an empty map. " +
        "Expected token:consumer_id pairs (see .env.example).",
    );
  }

  return map;
}

/** Split `s` on `delim`, honouring `\` escapes (`\,`, `\:`, `\\`). */
function splitEscaped(s: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === delim) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Index of the first unescaped `:` in `s`, or -1. */
function firstUnescapedColon(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === ":") return i;
  }
  return -1;
}

/** Collapse `\,`, `\:`, `\\` escapes into their literal characters. */
function unescape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      out += s[i + 1];
      i++;
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * Constant-time token lookup. Hashes both sides to a fixed-length digest so
 * timingSafeEqual never throws on length mismatch and the compare is O(1) in
 * token length. Returns the consumer_id on match, else null.
 */
function resolveConsumer(apiKeys: Map<string, string>, token: string): string | null {
  const candidate = sha256(token);
  let matched: string | null = null;
  // Iterate ALL keys (no early return) to keep timing independent of position.
  for (const [key, consumerId] of apiKeys) {
    const known = sha256(key);
    if (timingSafeEqual(candidate, known)) {
      matched = consumerId;
    }
  }
  return matched;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Bearer auth middleware. Exempt paths short-circuit to next(). All other
 * paths require a valid bearer token; the resolved consumer_id is attached via
 * c.set('consumer_id', ...).
 */
export function bearerAuth(apiKeys: Map<string, string>) {
  return createMiddleware<{ Variables: { consumer_id: string } }>(async (c, next) => {
    if (EXEMPT.has(c.req.path)) {
      return next();
    }

    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    const token = header ? extractBearer(header) : null;

    if (!token) {
      return unauthorized(c, "Missing or malformed Authorization header");
    }

    const consumerId = resolveConsumer(apiKeys, token);
    if (consumerId === null) {
      return unauthorized(c, "Invalid API key");
    }

    c.set("consumer_id", consumerId);
    return next();
  });
}

/** Strip a case-insensitive `Bearer ` scheme prefix; returns the token or null. */
function extractBearer(header: string): string | null {
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1]!.trim();
  return token === "" ? null : token;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unauthorized(c: any, message: string) {
  c.header("WWW-Authenticate", 'Bearer realm="geo-api"');
  return c.json({ error: "unauthorized", message }, 401);
}
