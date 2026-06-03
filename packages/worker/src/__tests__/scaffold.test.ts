/**
 * Wave 0 scaffold tests.
 *
 * (a) assertEnv() fail-fast: throws on missing ANTHROPIC_API_KEY, throws on
 *     missing DATABASE_URL, passes when both are set.
 * (b) Compile-time conformance: WorkerOptions references AuditDal (from @geo/db)
 *     and Fetcher (from @geo/core) — if those types diverge, tsc fails here first.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertEnv } from "../env.js";
import type { WorkerOptions, AnthropicMessagesClient } from "../types.js";
import type { AuditDal } from "@geo/db";
import type { Fetcher } from "@geo/core";

// ---------------------------------------------------------------------------
// (a) assertEnv tests
// ---------------------------------------------------------------------------

describe("assertEnv", () => {
  let savedAnthropicKey: string | undefined;
  let savedDatabaseUrl: string | undefined;

  beforeEach(() => {
    savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    savedDatabaseUrl = process.env["DATABASE_URL"];
  });

  afterEach(() => {
    // Restore original values
    if (savedAnthropicKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    }
    if (savedDatabaseUrl === undefined) {
      delete process.env["DATABASE_URL"];
    } else {
      process.env["DATABASE_URL"] = savedDatabaseUrl;
    }
  });

  it("throws when ANTHROPIC_API_KEY is missing", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["DATABASE_URL"] = "postgres://localhost/test";
    expect(() => assertEnv()).toThrow("ANTHROPIC_API_KEY");
  });

  it("throws when DATABASE_URL is missing", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    delete process.env["DATABASE_URL"];
    expect(() => assertEnv()).toThrow("DATABASE_URL");
  });

  it("does not throw when both vars are set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    process.env["DATABASE_URL"] = "postgres://localhost/test";
    expect(() => assertEnv()).not.toThrow();
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
