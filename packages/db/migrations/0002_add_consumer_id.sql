-- Migration 0002: Add consumer_id to audits (D-11)
-- Additive, nullable, NON-BREAKING: existing Phase 3 rows keep consumer_id = NULL.
-- Enables consumer-scoped ownership for API-02/03 (history) and API-04 (dedup).
-- findRecentByUrlHash / listJobs filter by consumer_id = $consumer EQUALITY;
-- legacy null-consumer rows never match any consumer.
-- Re-running this migration is a no-op (IF NOT EXISTS guards).

-- Nullable consumer_id column
ALTER TABLE audits ADD COLUMN IF NOT EXISTS consumer_id text;

-- Index: consumer-scoped history lookups (newest first), excludes legacy null rows
CREATE INDEX IF NOT EXISTS idx_audits_consumer_id
  ON audits (consumer_id, created_at DESC)
  WHERE consumer_id IS NOT NULL;
