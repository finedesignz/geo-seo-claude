/**
 * @geo/cron env fail-fast tests (Task 1).
 *
 * No secrets: tokens used here are clearly-fixture values. process.env is
 * mutated and restored per-test so assertEnv() can be exercised deterministically.
 */

import { describe, it, expect, afterEach } from "vitest";
import { assertEnv, parseTargetUrls } from "../env.js";

describe("parseTargetUrls", () => {
  it("splits a comma-separated list", () => {
    expect(parseTargetUrls("https://a.example,https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("splits a newline-separated list (D-2)", () => {
    expect(parseTargetUrls("https://a.example\nhttps://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(parseTargetUrls(" https://a.example , , https://b.example \n")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("throws on an empty string", () => {
    expect(() => parseTargetUrls("")).toThrow(/empty after parsing/);
  });

  it("throws on whitespace-only input", () => {
    expect(() => parseTargetUrls("  \n , \n ")).toThrow(/empty after parsing/);
  });

  it("throws naming the offending value on an invalid URL", () => {
    expect(() => parseTargetUrls("https://a.example,not-a-url")).toThrow(/not-a-url/);
  });

  it("throws on a non-http(s) protocol", () => {
    expect(() => parseTargetUrls("ftp://a.example")).toThrow(/ftp:\/\/a\.example/);
  });
});

describe("assertEnv", () => {
  const SAVED = {
    CRON_TARGET_URLS: process.env["CRON_TARGET_URLS"],
    CRON_API_TOKEN: process.env["CRON_API_TOKEN"],
    GEO_API_BASE_URL: process.env["GEO_API_BASE_URL"],
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function setAll() {
    process.env["CRON_TARGET_URLS"] = "https://a.example";
    process.env["CRON_API_TOKEN"] = "cron-token-fixture";
    process.env["GEO_API_BASE_URL"] = "https://api.example";
  }

  it("returns the three values when all are set", () => {
    setAll();
    expect(assertEnv()).toEqual({
      CRON_TARGET_URLS: "https://a.example",
      CRON_API_TOKEN: "cron-token-fixture",
      GEO_API_BASE_URL: "https://api.example",
    });
  });

  it("strips a trailing slash from GEO_API_BASE_URL (Pitfall 6)", () => {
    setAll();
    process.env["GEO_API_BASE_URL"] = "https://api.example/";
    expect(assertEnv().GEO_API_BASE_URL).toBe("https://api.example");
  });

  it("throws naming CRON_TARGET_URLS when unset", () => {
    setAll();
    delete process.env["CRON_TARGET_URLS"];
    expect(() => assertEnv()).toThrow(/CRON_TARGET_URLS is required/);
  });

  it("throws naming CRON_API_TOKEN when unset, without echoing a value", () => {
    setAll();
    delete process.env["CRON_API_TOKEN"];
    expect(() => assertEnv()).toThrow(/CRON_API_TOKEN is required/);
    try {
      assertEnv();
    } catch (err) {
      expect(String(err)).not.toContain("cron-token-fixture");
    }
  });

  it("throws naming GEO_API_BASE_URL when unset", () => {
    setAll();
    delete process.env["GEO_API_BASE_URL"];
    expect(() => assertEnv()).toThrow(/GEO_API_BASE_URL is required/);
  });
});
