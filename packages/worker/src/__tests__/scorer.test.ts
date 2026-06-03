/**
 * SCORE-01..04 — scorer.ts unit tests
 *
 * The Anthropic client is injected via the AnthropicMessagesClient interface.
 * Real SDK error subclasses are imported and thrown so instanceof checks in
 * classifyScoringError fire correctly. vi.mock('@anthropic-ai/sdk') is NOT used.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  createScorer,
  ScoringError,
  GEO_SCORING_RUBRIC,
} from "../scorer.js";
import type { AnthropicMessagesClient } from "../types.js";
import type { FindingsShape } from "@geo/db";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleFindings: FindingsShape = {
  robots: {
    allowed: true,
    disallowedPaths: [],
    aiCrawlerBlocked: false,
    crawlerRules: {},
  } as FindingsShape["robots"],
  llmsTxt: {
    present: true,
    valid: true,
    sections: 3,
    linkCount: 5,
  } as FindingsShape["llmsTxt"],
};

function buildMockResponse(overrides?: {
  content?: Anthropic.ContentBlock[];
  usage?: Partial<Anthropic.Usage & { cache_creation_input_tokens?: number; cache_read_input_tokens?: number }>;
}): Anthropic.Message {
  const defaultContent: Anthropic.ContentBlock[] = [
    {
      type: "tool_use",
      id: "toolu_01",
      name: "record_geo_score",
      input: { score: 72, findings: { crawlability: { points: 18 } } },
    },
  ];

  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    content: overrides?.content ?? defaultContent,
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 500,
      output_tokens: 100,
      cache_creation_input_tokens: overrides?.usage?.cache_creation_input_tokens ?? 1234,
      cache_read_input_tokens: overrides?.usage?.cache_read_input_tokens ?? 0,
      ...overrides?.usage,
    } as Anthropic.Usage,
  };
}

function buildMockClient(
  implementation?: () => Promise<Anthropic.Message>,
): AnthropicMessagesClient {
  return {
    messages: {
      create: vi.fn().mockImplementation(
        implementation ?? (() => Promise.resolve(buildMockResponse())),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// SCORE-01: single messages.create call with forced tool-use shape
// ---------------------------------------------------------------------------

describe("SCORE-01: single structured forced-tool-use call", () => {
  it("calls messages.create exactly once per score() invocation", async () => {
    const client = buildMockClient();
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await scorer.score(sampleFindings);

    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("passes tool_choice {type:'tool', name:'record_geo_score'}", async () => {
    const client = buildMockClient();
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await scorer.score(sampleFindings);

    const callArg = (client.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.tool_choice).toEqual({
      type: "tool",
      name: "record_geo_score",
    });
    expect(callArg.tools[0].name).toBe("record_geo_score");
  });

  it("returns zod-validated score === 72 from the tool_use block", async () => {
    const client = buildMockClient();
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    const result = await scorer.score(sampleFindings);

    expect(result.score).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// SCORE-02: findings (not HTML) is the dynamic input; rubric is static prefix
// ---------------------------------------------------------------------------

describe("SCORE-02: findings-not-HTML as dynamic input", () => {
  it("sends JSON.stringify(findings) as the user message content", async () => {
    const client = buildMockClient();
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await scorer.score(sampleFindings);

    const callArg = (client.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.messages[0].content).toBe(JSON.stringify(sampleFindings));
  });

  it("does NOT pass raw HTML in the user message", async () => {
    const client = buildMockClient();
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await scorer.score(sampleFindings);

    const callArg = (client.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const dynamicContent = callArg.messages[0].content as string;
    // Raw HTML would start with <html or <!DOCTYPE
    expect(dynamicContent).not.toMatch(/^\s*<!DOCTYPE/i);
    expect(dynamicContent).not.toMatch(/^\s*<html/i);
  });

  it("uses GEO_SCORING_RUBRIC as the static system block text", async () => {
    const client = buildMockClient();
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await scorer.score(sampleFindings);

    const callArg = (client.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.system[0].text).toBe(GEO_SCORING_RUBRIC);
  });
});

// ---------------------------------------------------------------------------
// SCORE-03: prompt caching — cache_control on static block; usage fields surfaced
// ---------------------------------------------------------------------------

describe("SCORE-03: prompt caching wired and proven via usage metadata", () => {
  it("includes cache_control:{type:'ephemeral'} on the system block", async () => {
    const client = buildMockClient();
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await scorer.score(sampleFindings);

    const callArg = (client.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArg.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("surfaces cache_creation_input_tokens from usage on first call", async () => {
    const client = buildMockClient(() =>
      Promise.resolve(
        buildMockResponse({
          usage: { cache_creation_input_tokens: 1234, cache_read_input_tokens: 0 },
        }),
      ),
    );
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    const result = await scorer.score(sampleFindings);

    const usage = result.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    expect(usage.cache_creation_input_tokens).toBe(1234);
    expect(usage.cache_read_input_tokens).toBe(0);
  });

  it("surfaces cache_read_input_tokens > 0 on subsequent (cache hit) calls", async () => {
    const client = buildMockClient(() =>
      Promise.resolve(
        buildMockResponse({
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 1234 },
        }),
      ),
    );
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    const result = await scorer.score(sampleFindings);

    const usage = result.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    expect(usage.cache_read_input_tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SCORE-04: typed error classification — all retryable:true; no partial score
// ---------------------------------------------------------------------------

describe("SCORE-04: exhaustive typed-error classification, retryable:true, no partial score", () => {
  it("APIConnectionTimeoutError → SCORING_TIMEOUT, retryable:true", async () => {
    const client = buildMockClient(() =>
      Promise.reject(new Anthropic.APIConnectionTimeoutError()),
    );
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await expect(scorer.score(sampleFindings)).rejects.toMatchObject({
      code: "SCORING_TIMEOUT",
      retryable: true,
      name: "ScoringError",
    });
  });

  it("APIUserAbortError → SCORING_TIMEOUT, retryable:true", async () => {
    const client = buildMockClient(() =>
      Promise.reject(
        new Anthropic.APIUserAbortError(),
      ),
    );
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await expect(scorer.score(sampleFindings)).rejects.toMatchObject({
      code: "SCORING_TIMEOUT",
      retryable: true,
    });
  });

  it("RateLimitError (429) → SCORING_RATE_LIMITED, retryable:true", async () => {
    const client = buildMockClient(() =>
      Promise.reject(
        new Anthropic.RateLimitError(
          429,
          { error: { type: "rate_limit_error", message: "rate limited" } },
          "rate limited",
          new Headers(),
        ),
      ),
    );
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await expect(scorer.score(sampleFindings)).rejects.toMatchObject({
      code: "SCORING_RATE_LIMITED",
      retryable: true,
    });
  });

  it("InternalServerError (5xx/529) → SCORING_API_ERROR, retryable:true", async () => {
    const client = buildMockClient(() =>
      Promise.reject(
        new Anthropic.InternalServerError(
          529,
          { error: { type: "overloaded_error", message: "overloaded" } },
          "overloaded",
          new Headers(),
        ),
      ),
    );
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await expect(scorer.score(sampleFindings)).rejects.toMatchObject({
      code: "SCORING_API_ERROR",
      retryable: true,
    });
  });

  it("missing tool_use block → SCORING_MALFORMED_OUTPUT, retryable:true (ROADMAP #4)", async () => {
    const client = buildMockClient(() =>
      Promise.resolve(
        buildMockResponse({
          content: [{ type: "text", text: "I cannot score this page." }],
        }),
      ),
    );
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await expect(scorer.score(sampleFindings)).rejects.toMatchObject({
      code: "SCORING_MALFORMED_OUTPUT",
      retryable: true,
    });
  });

  it("zod-invalid tool_use.input (score:150) → SCORING_MALFORMED_OUTPUT, retryable:true (ROADMAP #4)", async () => {
    const client = buildMockClient(() =>
      Promise.resolve(
        buildMockResponse({
          content: [
            {
              type: "tool_use",
              id: "toolu_02",
              name: "record_geo_score",
              input: { score: 150, findings: {} },
            },
          ],
        }),
      ),
    );
    const scorer = createScorer(client, {
      model: "claude-sonnet-4-6",
      timeoutMs: 30_000,
    });

    await expect(scorer.score(sampleFindings)).rejects.toMatchObject({
      code: "SCORING_MALFORMED_OUTPUT",
      retryable: true,
    });
  });

  it("no-partial-score: errors always throw ScoringError, never return a value", async () => {
    const errorCases = [
      new Anthropic.APIConnectionTimeoutError(),
      new Anthropic.RateLimitError(429, {}, "rate limited", new Headers()),
      new Anthropic.InternalServerError(500, {}, "internal error", new Headers()),
    ];

    for (const error of errorCases) {
      const client = buildMockClient(() => Promise.reject(error));
      const scorer = createScorer(client, {
        model: "claude-sonnet-4-6",
        timeoutMs: 30_000,
      });

      let returned: unknown = "__SENTINEL__";
      let threw = false;

      try {
        returned = await scorer.score(sampleFindings);
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(ScoringError);
      }

      expect(threw).toBe(true);
      expect(returned).toBe("__SENTINEL__");
    }
  });
});
