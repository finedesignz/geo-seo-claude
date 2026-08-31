-- Migration 0001: Create audits table
-- Implements D-06 column contract, D-07 indexes, updated_at trigger.
-- Uses gen_random_uuid() (built-in Postgres 13+ / PGlite — no pgcrypto needed).

-- Updated-at trigger function
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Audits table
CREATE TABLE IF NOT EXISTS audits (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  url              text        NOT NULL,
  normalized_url   text        NOT NULL,
  url_hash         text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued'
                               CONSTRAINT audits_status_check
                               CHECK (status IN ('queued','running','done','failed')),
  score            int         CONSTRAINT audits_score_check
                               CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  findings         jsonb,
  error_code       text,
  callback_url     text,
  attempts         int         NOT NULL DEFAULT 0,
  locked_at        timestamptz,
  lease_expires_at timestamptz,
  lease_token      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

-- Trigger: keep updated_at current on every UPDATE
CREATE TRIGGER audits_updated_at
  BEFORE UPDATE ON audits
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Index: claim path — next available queued job (partial, ordered by arrival)
CREATE INDEX IF NOT EXISTS idx_audits_queued
  ON audits (created_at, id)
  WHERE status = 'queued';

-- Index: expired running jobs (lease recovery)
CREATE INDEX IF NOT EXISTS idx_audits_running_expired
  ON audits (lease_expires_at)
  WHERE status = 'running';

-- Index: deduplication by url_hash
CREATE INDEX IF NOT EXISTS idx_audits_url_hash
  ON audits (url_hash);
