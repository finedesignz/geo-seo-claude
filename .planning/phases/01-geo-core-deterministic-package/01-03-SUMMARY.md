---
phase: 01-geo-core-deterministic-package
plan: "03"
subsystem: "@geo/core schema"
tags: [schema, structured-data, json-ld, zero-dep, security]
dependency_graph:
  requires: ["01-00", "01-01", "01-02"]
  provides: ["getSchemaTemplates", "validateStructuredData", "SchemaType"]
  affects: ["packages/core/src/index.ts"]
tech_stack:
  added: []
  patterns: ["regex JSON-LD extraction (Pattern-4)", "Object.hasOwn prototype-pollution guard", "input-length ReDoS guard"]
key_files:
  created:
    - packages/core/src/schema.ts
    - packages/core/src/__tests__/schema.test.ts
  modified:
    - packages/core/src/index.ts
decisions:
  - "jsonLdCount tracks script blocks (not flattened objects) so @graph/array blocks count as 1"
  - "StructuredDataValidationResult re-declared in schema.ts (richer shape than types.ts stub); types.ts stub retired from barrel"
  - "flattenJsonLd normalizes @graph + top-level arrays to flat object list before validation"
metrics:
  duration: "~15 minutes"
  completed: "2026-06-02"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 3
---

# Phase 1 Plan 03: getSchemaTemplates + validateStructuredData (CORE-03) Summary

**One-liner:** Zero-dep JSON-LD extractor/validator with six typed schema.org template generators, @graph/array normalization, and prototype-pollution + ReDoS guards.

## What Was Built

`packages/core/src/schema.ts` implements CORE-03:

- **`getSchemaTemplates(type: SchemaType)`** — returns a fresh typed schema.org template object for `Organization | WebSite | Article | Product | BreadcrumbList | FAQPage`. Fields seeded from `schema/*.json` repo files (D-09). Throws only on unknown type literal (programmer error, D-06).

- **`validateStructuredData(html: string)`** — extracts `<script type="application/ld+json">` blocks from raw HTML using the Pattern-4 lazy regex, parses each block in a try/catch (no throw on malformed), flattens `@graph` wrappers and top-level arrays, reports `found[]` with `{ type, valid, missingFields }` and `jsonLdCount` (script-block count, not object count).

Security mitigations applied per threat model:
- T-01-S1: `MAX_HTML_BYTES = 5 MB` input-length guard before regex pass.
- T-01-S2: All parsed-object field reads use `Object.hasOwn`; no spread/merge into shared templates.
- T-01-S3: Per-block try/catch; errors accumulated in `errors[]`; never rethrows.

## Tests

27 tests covering: all 6 template types, schema-rich/schema-none fixtures, malformed JSON, prototype pollution (`__proto__` + `constructor.prototype`), `@graph` wrapper, array `@type`, top-level array, unknown type degradation isolation, missing fields reporting, input-length guard, barrel exports. Full suite: **66/66 green**.

## Deviations from Plan

**1. [Rule 1 - Bug] Fixed jsonLdCount semantics for @graph + top-level arrays**
- Found during: Task 1 test run
- Issue: Initial impl incremented `jsonLdCount` per flattened object, so a single `@graph` block with 2 items returned `jsonLdCount: 2`.
- Fix: `jsonLdCount` increments per script block (regardless of how many objects are flattened from it). `ParsedBlock` now stores `objects[]` array instead of single `parsed`.
- Files modified: `packages/core/src/schema.ts`

**2. [Rule 2 - Type conflict] Retired `StructuredDataValidationResult` stub from types.ts barrel export**
- Found during: barrel construction
- Issue: `types.ts` had a stub `StructuredDataValidationResult` with a different shape (`valid, findings`); `schema.ts` defines the canonical richer shape (`found, jsonLdCount, errors`). Exporting both from barrel = duplicate identifier error.
- Fix: Removed `StructuredDataValidationResult` from the `types.ts` re-export in `index.ts`; the richer `schema.ts` version is the single export.

## Self-Check

- [x] `packages/core/src/schema.ts` exists
- [x] `packages/core/src/__tests__/schema.test.ts` exists
- [x] commit `694504c` exists
- [x] `bun run --cwd packages/core test -- --run schema` → 27/27 green
- [x] Full suite → 66/66 green

## Self-Check: PASSED
