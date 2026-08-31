/**
 * @geo/fetch — SSRF IP classifier (SEC-01)
 *
 * isBlockedIP(raw) returns true when the address should be denied:
 *   - loopback, private, link-local, cloud-metadata, ULA, unspecified, broadcast, multicast
 *   - IPv4-mapped IPv6 (::ffff:x.x.x.x) — unwrapped before range check
 *   - Obfuscated forms: octal (017700000001), hex (0x7f000001), decimal (2130706433)
 *   - Unparseable input → BLOCKED (deny by default, D-04)
 *
 * Strategy: deny anything whose ipaddr.js range() !== "unicast".
 * ipaddr.js normalizes all obfuscated notations; no manual parsing needed.
 */

import * as ipaddr from "ipaddr.js";

/**
 * Returns true if the IP address string should be blocked for SSRF safety.
 * Defaults to BLOCKED on any parse error (fail-closed).
 */
export function isBlockedIP(raw: string): boolean {
  try {
    let addr = ipaddr.parse(raw);

    // Unwrap IPv4-mapped IPv6 (::ffff:x.x.x.x) before range check (T-02-01)
    if (addr.kind() === "ipv6") {
      const v6 = addr as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) {
        addr = v6.toIPv4Address();
      }
    }

    return addr.range() !== "unicast";
  } catch {
    // Unparseable input — deny by default (D-04)
    return true;
  }
}
