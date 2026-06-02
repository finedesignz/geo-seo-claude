/**
 * SEC-01 — IP classifier table test
 *
 * Covers: loopback, private, link-local, cloud-metadata, broadcast,
 * unspecified, ULA, IPv6 loopback/link-local, IPv4-mapped IPv6,
 * obfuscated forms (octal/hex/decimal), and public unicast allow-list.
 */

import { describe, expect, it } from "vitest";
import { isBlockedIP } from "../ip-validator.js";

// ---------------------------------------------------------------------------
// BLOCKED cases
// ---------------------------------------------------------------------------

describe("isBlockedIP — BLOCKED", () => {
  // Loopback IPv4
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback upper bound"],
    ["127.0.0.2", "loopback non-canonical"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(true);
  });

  // Private IPv4
  it.each([
    ["10.0.0.1", "RFC-1918 /8"],
    ["10.255.255.255", "RFC-1918 /8 upper"],
    ["172.16.0.1", "RFC-1918 /12"],
    ["172.31.255.255", "RFC-1918 /12 upper"],
    ["192.168.0.1", "RFC-1918 /16"],
    ["192.168.255.255", "RFC-1918 /16 upper"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(true);
  });

  // Link-local / cloud-metadata (SEC-01, T-02-03)
  it.each([
    ["169.254.169.254", "cloud metadata IMDSv2"],
    ["169.254.1.1", "link-local"],
    ["169.254.0.0", "link-local base"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(true);
  });

  // Unspecified + broadcast
  it.each([
    ["0.0.0.0", "unspecified"],
    ["255.255.255.255", "broadcast"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(true);
  });

  // IPv6 loopback, link-local, ULA, unspecified
  it.each([
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fc00::1", "ULA fc00::/7"],
    ["fd00::1", "ULA fd00::/8"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ULA upper"],
    ["fe80::1", "IPv6 link-local"],
    ["fe80::1%eth0", "IPv6 scoped link-local"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(true);
  });

  // IPv4-mapped IPv6 — must unwrap before range check (T-02-01)
  it.each([
    ["::ffff:169.254.169.254", "IPv4-mapped cloud metadata"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:192.168.1.1", "IPv4-mapped private"],
    ["::ffff:10.0.0.1", "IPv4-mapped RFC-1918"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(true);
  });

  // Obfuscated IPv4 forms — ipaddr.js normalizes (T-02-02)
  it.each([
    ["2130706433", "decimal 127.0.0.1"],
    ["017700000001", "octal 127.0.0.1"],
    ["0x7f000001", "hex 127.0.0.1"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(true);
  });

  // Unparseable / garbage — deny by default (D-04)
  it.each([
    ["not-an-ip", "garbage string"],
    ["", "empty string"],
    ["999.999.999.999", "out-of-range octets"],
    ["localhost", "hostname"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ALLOWED cases — public unicast only
// ---------------------------------------------------------------------------

describe("isBlockedIP — ALLOWED", () => {
  it.each([
    ["8.8.8.8", "Google DNS"],
    ["1.1.1.1", "Cloudflare DNS"],
    ["8.8.4.4", "Google DNS secondary"],
    ["2606:4700:4700::1111", "Cloudflare IPv6 DNS"],
    ["2001:4860:4860::8888", "Google IPv6 DNS"],
  ])("allows %s (%s)", (ip) => {
    expect(isBlockedIP(ip)).toBe(false);
  });
});
