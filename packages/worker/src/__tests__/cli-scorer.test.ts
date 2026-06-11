/**
 * cli-scorer tests — the Claude Code CLI (subscription) scoring path.
 *
 * The spawn is injected (CliSpawnFn), so no real `claude` process runs. We
 * assert: argv shape (no bypass flags), API-key stripping for subscription auth,
 * stream-json result parsing, fence stripping, and the ScoringError taxonomy.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createCliScorer,
  buildCliArgv,
  extractCliResult,
  type CliSpawnFn,
  type CliSpawnResult,
} from "../cli-scorer.js";
import { ScoringError } from "../scorer.js";
import type { FindingsShape } from "@geo/db";

const FINDINGS = {} as FindingsShape;

/** Build a stream-json stdout whose final line is a success result carrying `result`. */
function streamJson(resultText: string): string {
  return (
    JSON.stringify({ type: "system", subtype: "init" }) +
    "\n" +
    JSON.stringify({ type: "assistant", message: { content: [] } }) +
    "\n" +
    JSON.stringify({ type: "result", subtype: "success", result: resultText }) +
    "\n"
  );
}

function fakeSpawn(result: Partial<CliSpawnResult>): CliSpawnFn {
  return vi.fn(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...result,
  }));
}

describe("buildCliArgv", () => {
  it("is print-mode, single-turn, stream-json, with model — and no bypass flags", () => {
    const argv = buildCliArgv("PROMPT", "claude-sonnet-4-6");
    expect(argv).toContain("-p");
    expect(argv).toContain("PROMPT");
    expect(argv).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
    expect(argv).toEqual(expect.arrayContaining(["--max-turns", "1"]));
    expect(argv).toEqual(expect.arrayContaining(["--model", "claude-sonnet-4-6"]));
    expect(argv.join(" ")).not.toMatch(/dangerous|bypassPermissions|skip-permissions/i);
  });
});

describe("extractCliResult", () => {
  it("returns the success result text", () => {
    expect(extractCliResult(streamJson('{"score":42,"findings":{}}'))).toBe(
      '{"score":42,"findings":{}}',
    );
  });
  it("returns null when no success line is present", () => {
    expect(extractCliResult('{"type":"result","subtype":"error_max_turns"}\n')).toBeNull();
  });
});

describe("createCliScorer.score", () => {
  it("parses a valid score from stream-json", async () => {
    const spawnFn = fakeSpawn({ stdout: streamJson('{"score":73,"findings":{"crawlability":{"points":18}}}') });
    const scorer = createCliScorer({ model: "claude-sonnet-4-6", timeoutMs: 5000, spawnFn });
    const out = await scorer.score(FINDINGS);
    expect(out.score).toBe(73);
    expect(out.findings).toEqual({ crawlability: { points: 18 } });
  });

  it("strips a ```json code fence the model may add", async () => {
    const fenced = "```json\n{\"score\":50,\"findings\":{}}\n```";
    const spawnFn = fakeSpawn({ stdout: streamJson(fenced) });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, spawnFn });
    expect((await scorer.score(FINDINGS)).score).toBe(50);
  });

  it("strips ANTHROPIC_API_KEY from the child env (forces subscription auth)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-not-leak";
    const spawnFn = fakeSpawn({ stdout: streamJson('{"score":1,"findings":{}}') });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, spawnFn });
    await scorer.score(FINDINGS);
    const passedEnv = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]![2].env;
    expect(passedEnv["ANTHROPIC_API_KEY"]).toBeUndefined();
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("uses the configured claudeBin", async () => {
    const spawnFn = fakeSpawn({ stdout: streamJson('{"score":1,"findings":{}}') });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, claudeBin: "/opt/claude", spawnFn });
    await scorer.score(FINDINGS);
    expect((spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("/opt/claude");
  });

  it("maps timeout → SCORING_TIMEOUT (retryable)", async () => {
    const spawnFn = fakeSpawn({ timedOut: true, exitCode: null });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, spawnFn });
    await expect(scorer.score(FINDINGS)).rejects.toMatchObject({
      code: "SCORING_TIMEOUT",
      retryable: true,
    });
  });

  it("maps non-zero exit → SCORING_API_ERROR", async () => {
    const spawnFn = fakeSpawn({ exitCode: 1, stderr: "auth error" });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, spawnFn });
    await expect(scorer.score(FINDINGS)).rejects.toMatchObject({ code: "SCORING_API_ERROR" });
  });

  it("maps missing success line → SCORING_MALFORMED_OUTPUT", async () => {
    const spawnFn = fakeSpawn({ stdout: '{"type":"system"}\n' });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, spawnFn });
    await expect(scorer.score(FINDINGS)).rejects.toMatchObject({
      code: "SCORING_MALFORMED_OUTPUT",
    });
  });

  it("maps non-JSON result → SCORING_MALFORMED_OUTPUT", async () => {
    const spawnFn = fakeSpawn({ stdout: streamJson("not json at all") });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, spawnFn });
    await expect(scorer.score(FINDINGS)).rejects.toMatchObject({
      code: "SCORING_MALFORMED_OUTPUT",
    });
  });

  it("maps schema violation (score out of range) → SCORING_MALFORMED_OUTPUT", async () => {
    const spawnFn = fakeSpawn({ stdout: streamJson('{"score":250,"findings":{}}') });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, spawnFn });
    await expect(scorer.score(FINDINGS)).rejects.toBeInstanceOf(ScoringError);
  });

  it("aborts via external signal → SCORING_TIMEOUT", async () => {
    const ac = new AbortController();
    ac.abort();
    const spawnFn = fakeSpawn({ timedOut: false, stdout: streamJson('{"score":1,"findings":{}}') });
    const scorer = createCliScorer({ model: "m", timeoutMs: 5000, spawnFn });
    await expect(scorer.score(FINDINGS, ac.signal)).rejects.toMatchObject({
      code: "SCORING_TIMEOUT",
    });
  });
});
