/**
 * @geo/worker — cli-scorer.ts
 *
 * Alternative scorer that drives the **Claude Code CLI** (the logged-in
 * subscription session) instead of the Anthropic Messages API + API key.
 *
 * This is a direct port of the titanium-edge-autobuilder pattern
 * (packages/engine/src/providers/spawn-structured-subagent.ts): spawn
 * `claude -p <prompt> --output-format stream-json --verbose --model <id>`,
 * scan stdout in reverse for the `{type:"result",subtype:"success"}` line,
 * then zod-validate the structured payload. No bypass flags; the child tree
 * is killed on timeout/abort.
 *
 * Auth (login): the spawned `claude` binary authenticates via its own session —
 * an ambient `claude login` on a workstation, or `CLAUDE_CODE_OAUTH_TOKEN`
 * (from `claude setup-token`) in a headless container. Either way it bills the
 * Claude subscription, NOT the API.
 *
 * CRITICAL: if `ANTHROPIC_API_KEY` is present in the environment, the `claude`
 * CLI prefers it and bills via the API instead of the subscription. So we strip
 * `ANTHROPIC_API_KEY` from the child process env — forcing subscription auth.
 *
 * The returned object is shape-compatible with createScorer() (scorer.ts), so
 * worker.ts/pipeline.ts consume it through the identical `.score()` seam.
 */

import { spawn } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";
import type { FindingsShape } from "@geo/db";
import {
  GEO_SCORING_RUBRIC,
  GeoScoreSchema,
  ScoringError,
  type ScoreResult,
} from "./scorer.js";

// ---------------------------------------------------------------------------
// Spawn seam — injectable so tests never spawn a real `claude` process
// ---------------------------------------------------------------------------

export interface CliSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CliSpawnOptions {
  /** Hard timeout (ms); the child tree is killed when it elapses. */
  timeoutMs: number;
  /** External abort (lease-loss) — kills the child when fired. */
  signal: AbortSignal;
  /** Environment for the child (ANTHROPIC_API_KEY already stripped by caller). */
  env: NodeJS.ProcessEnv;
}

export type CliSpawnFn = (
  bin: string,
  args: string[],
  opts: CliSpawnOptions,
) => Promise<CliSpawnResult>;

/**
 * Default spawn implementation over node:child_process.
 * Collects stdout/stderr, enforces the timeout, and kills the process tree on
 * timeout OR external abort. Never rejects — always resolves a CliSpawnResult.
 */
const defaultSpawnFn: CliSpawnFn = (bin, args, opts) =>
  new Promise<CliSpawnResult>((resolve) => {
    const child = spawn(bin, args, {
      env: opts.env,
      // POSIX: own process group so we can kill the whole tree; not on Windows.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already dead */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);

    const onAbort = () => {
      kill();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });

// ---------------------------------------------------------------------------
// argv construction (mirrors autobuilder buildSubagentArgv; NEVER bypass flags)
// ---------------------------------------------------------------------------

/**
 * Build the `claude -p` argv. Print mode, single turn, stream-json output, no
 * tools (pure structured-JSON return). Never adds a bypass/dangerous flag.
 */
export function buildCliArgv(prompt: string, model: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "1",
    "--model",
    model,
  ];
}

// ---------------------------------------------------------------------------
// stream-json result extraction (mirrors autobuilder extractStreamJsonResult)
// ---------------------------------------------------------------------------

/**
 * Scan stream-json stdout in reverse and return the first
 * {type:"result",subtype:"success"}.result text. Per-line parse failures are
 * swallowed during the scan. Returns null if no success line is present.
 */
export function extractCliResult(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const msg = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (msg["type"] === "result" && msg["subtype"] === "success") {
        return typeof msg["result"] === "string" ? (msg["result"] as string) : null;
      }
    } catch {
      // per-line parse failure — keep scanning
    }
  }
  return null;
}

/** Strip an optional ```json … ``` (or bare ```) fence the model may add. */
function stripJsonFence(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1]! : t).trim();
}

// ---------------------------------------------------------------------------
// Prompt assembly — reuse the existing rubric, override the tool instruction
// ---------------------------------------------------------------------------

/**
 * Build the single `-p` prompt. Reuses GEO_SCORING_RUBRIC verbatim, then
 * overrides its "call the record_geo_score tool" instruction with a raw-JSON
 * output contract (no tools are available in headless print mode).
 */
export function buildCliPrompt(findings: FindingsShape): string {
  return (
    GEO_SCORING_RUBRIC +
    "\n\n---\n" +
    "## CLI OUTPUT OVERRIDE (read this last — it supersedes the tool instruction above)\n" +
    "There are NO tools available. Ignore every instruction to call a tool named " +
    "`record_geo_score`. Instead, output your evaluation as a SINGLE raw JSON object " +
    "and NOTHING ELSE — no prose, no markdown, no code fences. The object MUST be exactly:\n" +
    '{"score": <integer 0-100>, "findings": { <per-dimension objects as specified above> }}\n\n' +
    "## Findings to score\n" +
    JSON.stringify(findings)
  );
}

// ---------------------------------------------------------------------------
// createCliScorer — factory returning the same `{ score() }` shape as scorer.ts
// ---------------------------------------------------------------------------

export interface CliScorerOptions {
  model: string;
  timeoutMs: number;
  /** Absolute path to the `claude` binary; defaults to `claude` on PATH. */
  claudeBin?: string;
  /** Injectable spawn (default: node:child_process). Tests pass a fake. */
  spawnFn?: CliSpawnFn;
}

/** Zero-valued usage stand-in: subscription/CLI scoring isn't API-token-billed. */
function emptyUsage(): Anthropic.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
  } as Anthropic.Usage;
}

export function createCliScorer(opts: CliScorerOptions) {
  const bin = opts.claudeBin ?? "claude";
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;

  return {
    async score(
      findings: FindingsShape,
      externalSignal?: AbortSignal,
    ): Promise<ScoreResult> {
      const ac = new AbortController();
      if (externalSignal?.aborted) ac.abort();
      else if (externalSignal)
        externalSignal.addEventListener("abort", () => ac.abort(), { once: true });

      // Force subscription auth: never let the CLI see an API key (it would bill
      // the API instead of the Claude Code subscription).
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv["ANTHROPIC_API_KEY"];

      const argv = buildCliArgv(buildCliPrompt(findings), opts.model);

      const result = await spawnFn(bin, argv, {
        timeoutMs: opts.timeoutMs,
        signal: ac.signal,
        env: childEnv,
      });

      if (result.timedOut || ac.signal.aborted) {
        throw new ScoringError("SCORING_TIMEOUT", true);
      }
      if (result.exitCode !== 0) {
        // Non-zero exit: spawn failure, auth failure, or CLI error. Retryable —
        // the lease/attempts mechanism decides when to give up.
        throw new ScoringError("SCORING_API_ERROR", true);
      }

      const resultText = extractCliResult(result.stdout);
      if (resultText === null) {
        throw new ScoringError("SCORING_MALFORMED_OUTPUT", true);
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(stripJsonFence(resultText));
      } catch {
        throw new ScoringError("SCORING_MALFORMED_OUTPUT", true);
      }

      const parsed = GeoScoreSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new ScoringError("SCORING_MALFORMED_OUTPUT", true);
      }

      return {
        score: parsed.data.score,
        findings: parsed.data.findings,
        usage: emptyUsage(),
      };
    },
  };
}
