import { describe, it, expect } from "vitest";
import { createCliScorer, type CliSpawnResult } from "../cli-scorer.js";
import { ScoringError } from "../scorer.js";

const streamJson = (result: string) => JSON.stringify({ type: "result", subtype: "success", result });
const scorerFor = (result: Partial<CliSpawnResult>) => createCliScorer({
  model: "fixture", timeoutMs: 5000,
  spawnFn: async () => ({ exitCode: 0, timedOut: false, stderr: "", stdout: "", ...result }),
});

async function diagnostic(result: Partial<CliSpawnResult>): Promise<ScoringError> {
  const error = await scorerFor(result).score({}).catch((err: unknown) => err);
  expect(error).toBeInstanceOf(ScoringError);
  expect((error as ScoringError).retryable).toBe(true);
  return error as ScoringError;
}

describe("scoring diagnostics keep auth fixtures secret", () => {
  const authKeys = [
    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE",
  ];

  it.each(authKeys)("redacts %s from stderr and every malformed-output diagnostic", async (key) => {
    const saved = process.env[key];
    const secret = "fakeSecret123";
    process.env[key] = secret;
    try {
      for (const result of [
        { exitCode: 2, stderr: `auth failed: ${secret}` },
        { stdout: secret }, // No success envelope.
        { stdout: streamJson(secret) }, // Parser errors can quote their input.
        { stdout: streamJson(JSON.stringify({ score: secret, findings: {} })) },
        { stdout: streamJson(JSON.stringify({ score: 1, findings: secret })) },
        { stdout: streamJson(JSON.stringify({ score: -1, findings: {}, [secret]: secret })) },
      ]) {
        const error = await diagnostic(result);
        expect(error.message).toContain("[REDACTED]");
        expect(error.message).not.toContain(secret);
      }
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  it("never exposes a parser's truncated secret prefix and redacts before truncating", async () => {
    const key = "ANTHROPIC_AUTH_TOKEN";
    const saved = process.env[key];
    const secret = "uniqueFixtureSecret" + "x".repeat(1000);
    process.env[key] = secret;
    try {
      for (const result of [
        { exitCode: 2, stderr: `auth failed: ${secret}` },
        { stdout: secret },
        { stdout: streamJson(secret) },
        { stdout: streamJson(JSON.stringify({ score: secret, findings: {} })) },
      ]) {
        const error = await diagnostic(result);
        expect(error.message).toContain("[REDACTED]");
        expect(error.message).not.toContain(secret.slice(0, 8));
        expect(error.message.length).toBeLessThan(700);
      }
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  it("keeps bounded, useful diagnostics for non-sensitive invalid JSON", async () => {
    const error = await diagnostic({ stdout: streamJson("not-json " + "x".repeat(2000)) });
    expect(error.code).toBe("SCORING_MALFORMED_OUTPUT");
    expect(error.message).toContain("JSON.parse failed");
    expect(error.message).toContain("raw result: not-json");
    expect(error.message.length).toBeLessThan(700);
  });

  it("schema diagnostics do not echo invalid secret values or unknown keys", async () => {
    const key = "ANTHROPIC_AUTH_TOKEN";
    const saved = process.env[key];
    const secret = "schemaFixtureSecret";
    process.env[key] = secret;
    try {
      for (const input of [
        { score: secret, findings: {} },
        { score: 1, findings: secret },
        { score: -1, findings: {}, [secret]: secret },
      ]) {
        const error = await diagnostic({ stdout: streamJson(JSON.stringify(input)) });
        expect(error.message).toContain("zod validation failed");
        expect(error.message).toContain("[REDACTED]");
        expect(error.message).not.toContain(secret);
      }
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
});
