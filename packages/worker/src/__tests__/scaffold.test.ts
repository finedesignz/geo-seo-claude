/**
 * Wave 0 scaffold tests.
 *
 * (a) assertEnv() fail-fast: throws on missing ANTHROPIC_API_KEY, throws on
 *     missing DATABASE_URL, passes when both are set.
 * (b) Compile-time conformance: WorkerOptions references AuditDal (from @geo/db)
 *     and Fetcher (from @geo/core) — if those types diverge, tsc fails here first.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertEnv, resolveScoringProvider } from "../env.js";
import type { WorkerOptions, AnthropicMessagesClient } from "../types.js";
import type { AuditDal } from "@geo/db";
import type { Fetcher } from "@geo/core";

// ---------------------------------------------------------------------------
// (a) assertEnv tests
// ---------------------------------------------------------------------------

describe("assertEnv", () => {
  const KEYS = [
    "ANTHROPIC_API_KEY",
    "DATABASE_URL",
    "SCORING_PROVIDER",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("api provider: throws when ANTHROPIC_API_KEY is missing", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["DATABASE_URL"] = "postgres://localhost/test";
    expect(() => assertEnv("api")).toThrow("ANTHROPIC_API_KEY");
  });

  it("api provider: throws when DATABASE_URL is missing", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    delete process.env["DATABASE_URL"];
    expect(() => assertEnv("api")).toThrow("DATABASE_URL");
  });

  it("api provider: does not throw when both vars are set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    process.env["DATABASE_URL"] = "postgres://localhost/test";
    expect(() => assertEnv("api")).not.toThrow();
  });

  it("cli provider: does not require ANTHROPIC_API_KEY", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "oat-test";
    process.env["DATABASE_URL"] = "postgres://localhost/test";
    expect(() => assertEnv("cli")).not.toThrow();
  });

  it("cli provider: still requires DATABASE_URL", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "oat-test";
    delete process.env["DATABASE_URL"];
    expect(() => assertEnv("cli")).toThrow("DATABASE_URL");
  });

  it("resolveScoringProvider: defaults to api with a key, cli without", () => {
    delete process.env["SCORING_PROVIDER"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    expect(resolveScoringProvider()).toBe("api");
    delete process.env["ANTHROPIC_API_KEY"];
    expect(resolveScoringProvider()).toBe("cli");
  });

  it("resolveScoringProvider: explicit value wins; bad value throws", () => {
    process.env["SCORING_PROVIDER"] = "cli";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    expect(resolveScoringProvider()).toBe("cli");
    process.env["SCORING_PROVIDER"] = "bogus";
    expect(() => resolveScoringProvider()).toThrow("SCORING_PROVIDER");
  });
});

// ---------------------------------------------------------------------------
// (b) Compile-time conformance assertions
// These casts fail tsc if the types diverge from @geo/db or @geo/core.
// ---------------------------------------------------------------------------

describe("type conformance (compile-time)", () => {
  it("WorkerOptions accepts AuditDal and Fetcher", () => {
    // Minimal stub satisfying AuditDal — if AuditDal changes, tsc fails here.
    const stubDal = {} as AuditDal;
    const stubFetcher: Fetcher = async (_url: string) => ({
      url: _url,
      status: 200,
      headers: {},
      body: "",
      redirectChain: [],
    });
    const stubAnthropic = {} as AnthropicMessagesClient;

    // WorkerOptions literal — tsc verifies field types match.
    const _opts: WorkerOptions = {
      concurrency: 1,
      pollIntervalMs: 1000,
      leaseTtlSecs: 30,
      reclaimIntervalMs: 5000,
      maxAttempts: 3,
      scoringTimeoutMs: 30000,
      shutdownGraceMs: 5000,
      scoringModel: "claude-opus-4-5",
      dal: stubDal,
      anthropic: stubAnthropic,
      fetcherFactory: () => stubFetcher,
    };

    // Trivial runtime assertion — value is that the file type-checks.
    expect(_opts.concurrency).toBe(1);
  });
});
