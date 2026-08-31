"use strict";
/**
 * CJS consumability smoke — runs against the built dist.
 * Verifies the exports map resolves correctly for CommonJS consumers.
 */
const geo = require("../dist/index.cjs");

const REQUIRED_FUNCTIONS = [
  "checkRobots",
  "generateLlmsTxt",
  "validateLlmsTxt",
  "getSchemaTemplates",
  "validateStructuredData",
  "computeCitabilityScore",
  "scorePassage",
  "detectRendering",
  "normalizeUrl",
];

const REQUIRED_OBJECTS = ["CITABILITY_WEIGHTS", "AI_CRAWLERS"];

let failed = false;

for (const name of REQUIRED_FUNCTIONS) {
  if (typeof geo[name] !== "function") {
    console.error(`FAIL [CJS]: '${name}' is not a function (got ${typeof geo[name]})`);
    failed = true;
  }
}

for (const name of REQUIRED_OBJECTS) {
  if (geo[name] === undefined || geo[name] === null) {
    console.error(`FAIL [CJS]: '${name}' is missing or null`);
    failed = true;
  }
}

if (!Array.isArray(geo.AI_CRAWLERS)) {
  console.error(`FAIL [CJS]: AI_CRAWLERS is not an array`);
  failed = true;
}

if (typeof geo.CITABILITY_WEIGHTS !== "object") {
  console.error(`FAIL [CJS]: CITABILITY_WEIGHTS is not an object`);
  failed = true;
} else {
  const sum = Object.values(geo.CITABILITY_WEIGHTS).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.001) {
    console.error(`FAIL [CJS]: CITABILITY_WEIGHTS sums to ${sum}, expected 100`);
    failed = true;
  }
}

// Zero-dep assertion: package.json must have no dependencies key (or empty)
const pkg = require("../package.json");
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  console.error(
    `FAIL [CJS]: package.json has runtime dependencies: ${JSON.stringify(pkg.dependencies)}`
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log("PASS [CJS]: all exports resolved and verified via dist/index.cjs");
console.log("PASS [ZERO-DEP]: package.json has no runtime dependencies");
