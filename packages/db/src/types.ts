/**
 * @geo/db — typed contract for the audits table (D-06, D-10).
 *
 * FindingsShape imports from @geo/core — do NOT re-declare.
 * This file is the single source of truth; dal.ts imports from here.
 */

import type {
  RobotsResult,
  LlmsTxtResult,
  SchemaTemplateResult,
  StructuredDataValidationResult,
  CitabilityResult,
  RenderingResult,
} from "@geo/core";

// ---------------------------------------------------------------------------
// Status union
// ---------------------------------------------------------------------------

export type AuditStatus = "queued" | "running" | "done" | "failed";

// ---------------------------------------------------------------------------
// Findings shape (composed from @geo/core result types)
// ---------------------------------------------------------------------------

export interface FindingsShape {
  robots?: RobotsResult;
  llmsTxt?: LlmsTxtResult;
  schemaTemplate?: SchemaTemplateResult;
  structuredData?: StructuredDataValidationResult;
  citability?: CitabilityResult;
  rendering?: RenderingResult;
}

// ---------------------------------------------------------------------------
// AuditJob row (mirrors audits table columns, D-06)
// ---------------------------------------------------------------------------

export interface AuditJob {
  id: string;
  url: string;
  normalizedUrl: string;
  urlHash: string;
  status: AuditStatus;
  score: number | null;
  findings: FindingsShape | null;
  errorCode: string | null;
  callbackUrl: string | null;
  /** Owning consumer (D-11). Null for legacy pre-auth rows. */
  consumerId: string | null;
  attempts: number;
  lockedAt: Date | null;
  leaseExpiresAt: Date | null;
  leaseToken: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface InsertJobInput {
  url: string;
  normalizedUrl: string;
  urlHash: string;
  callbackUrl?: string;
  /** Owning consumer (D-11). Omitted → stored as NULL (back-compat). */
  consumerId?: string;
}

export interface PaginationInput {
  limit: number;
  offset: number;
  /** Scope history to this consumer (D-11). Omitted → all rows (back-compat). */
  consumerId?: string;
}
