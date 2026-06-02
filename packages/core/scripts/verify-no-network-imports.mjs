#!/usr/bin/env node
/**
 * Asserts that packages/core/src contains no direct network or FS import statements.
 * Grep for actual import statements only (not variable names or comments).
 */
import { readdirSync, readFileSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "../src");

// Patterns that indicate a real import of a network/FS module
const FORBIDDEN_IMPORT_PATTERNS = [
  /^\s*import\s+.*\bfrom\s+['"]node:fetch['"]/m,
  /^\s*import\s+.*\bfrom\s+['"]node:http['"]/m,
  /^\s*import\s+.*\bfrom\s+['"]node:https['"]/m,
  /^\s*import\s+.*\bfrom\s+['"]node:net['"]/m,
  /^\s*import\s+.*\bfrom\s+['"]node:dns['"]/m,
  /^\s*import\s+.*\bfrom\s+['"]node:fs['"]/m,
  /^\s*import\s+.*\bfrom\s+['"]http['"]/m,
  /^\s*import\s+.*\bfrom\s+['"]https['"]/m,
  /^\s*import\s+.*\bfrom\s+['"]fs['"]/m,
  /^\s*const\s+.*=\s*require\(['"]node:fetch['"]\)/m,
  /^\s*const\s+.*=\s*require\(['"]node:http['"]\)/m,
  /^\s*const\s+.*=\s*require\(['"]node:https['"]\)/m,
  /^\s*const\s+.*=\s*require\(['"]node:fs['"]\)/m,
];

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory() && e.name !== "__tests__") {
      files.push(...walk(full));
    } else if (e.isFile() && (extname(e.name) === ".ts" || extname(e.name) === ".js")) {
      files.push(full);
    }
  }
  return files;
}

let failed = false;
const files = walk(SRC_DIR);

for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const pat of FORBIDDEN_IMPORT_PATTERNS) {
    if (pat.test(content)) {
      console.error(`FAIL [no-network-imports]: forbidden pattern ${pat} in ${file}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log(`PASS [no-network-imports]: ${files.length} source files checked — no forbidden network/FS imports`);
