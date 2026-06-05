/**
 * gen-docs — generate packages/api/docs/api.md from the live /openapi.json
 * (global rule 21 backend adapter).
 *
 * Boots createApp with a no-op DAL stub (only /openapi.json is fetched — the
 * spec is derived from the zod route schemas, no DB needed), fetches the spec,
 * and renders a deterministic markdown summary committed to docs/api.md.
 *
 * Regenerate with:  bun run --cwd packages/api gen-docs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import type { AuditDal } from "@geo/db";
import { createSafeFetcher } from "@geo/fetch";

/** Minimal DAL stub — gen-docs never executes a handler, only reads the spec. */
const stubDal = new Proxy({}, {
  get() {
    return async () => {
      throw new Error("gen-docs: DAL not callable");
    };
  },
}) as AuditDal;

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { summary?: string; tags?: string[]; security?: unknown[] }>>;
  components?: { securitySchemes?: Record<string, { type: string; scheme: string }> };
}

async function main(): Promise<void> {
  const app = createApp({
    dal: stubDal,
    fetcher: createSafeFetcher(),
    apiKeys: new Map([["__gendocs__", "gendocs"]]),
  });

  const doc = (await (await app.request("/openapi.json")).json()) as OpenApiDoc;

  const lines: string[] = [];
  lines.push(`# ${doc.info.title} API`);
  lines.push("");
  lines.push(`> Generated from \`/openapi.json\` (OpenAPI ${doc.openapi}). Do not edit by hand.`);
  lines.push(`> Regenerate: \`bun run --cwd packages/api gen-docs\``);
  lines.push("");
  lines.push(`**Version:** ${doc.info.version}`);
  lines.push("");

  const schemes = doc.components?.securitySchemes ?? {};
  if (Object.keys(schemes).length > 0) {
    lines.push("## Security Schemes");
    lines.push("");
    lines.push("| Name | Type | Scheme |");
    lines.push("| ---- | ---- | ------ |");
    for (const [name, s] of Object.entries(schemes)) {
      lines.push(`| ${name} | ${s.type} | ${s.scheme} |`);
    }
    lines.push("");
  }

  lines.push("## Endpoints");
  lines.push("");
  lines.push("| Method | Path | Auth | Summary |");
  lines.push("| ------ | ---- | ---- | ------- |");
  const sortedPaths = Object.keys(doc.paths).sort();
  for (const path of sortedPaths) {
    const methods = doc.paths[path]!;
    for (const method of Object.keys(methods).sort()) {
      const op = methods[method]!;
      const auth = op.security && op.security.length > 0 ? "BearerAuth" : "public";
      lines.push(`| ${method.toUpperCase()} | \`${path}\` | ${auth} | ${op.summary ?? ""} |`);
    }
  }
  lines.push("");

  const docsDir = join(import.meta.dirname, "..", "docs");
  mkdirSync(docsDir, { recursive: true });
  const out = join(docsDir, "api.md");
  writeFileSync(out, lines.join("\n"), "utf8");
  // eslint-disable-next-line no-console
  console.log(`[gen-docs] wrote ${out} (${sortedPaths.length} paths)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[gen-docs] failed:", err);
  process.exit(1);
});
