-- Public publisher facts only. Tenant/client annotations are deliberately not stored here.
-- Current pointer and immutable revisions advance together in one producer transaction.
BEGIN;
CREATE TABLE government_forecast_source (
  sha256 text PRIMARY KEY,
  edition text NOT NULL,
  source_xml text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE government_forecast (
  id text PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  rin text NOT NULL,
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  content_hash text,
  observed_at timestamptz,
  window_from date,
  window_to date,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'withdrawn', 'source_completed')),
  CHECK ((window_from IS NULL AND window_to IS NULL) OR
    (window_from IS NOT NULL AND window_to IS NOT NULL AND window_from < window_to))
);
CREATE TABLE government_forecast_revision (
  forecast_id text NOT NULL REFERENCES government_forecast(id),
  revision integer NOT NULL CHECK (revision > 0),
  content jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (forecast_id, revision)
);
CREATE INDEX government_forecast_window ON government_forecast(window_from, window_to);
CREATE INDEX government_forecast_rin ON government_forecast(rin);
CREATE TABLE government_forecast_check (
  id bigserial PRIMARY KEY,
  snapshot_sha256 text REFERENCES government_forecast_source(sha256),
  edition text,
  attempted_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('success', 'failed')),
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  UNIQUE (snapshot_sha256, attempted_at)
);
CREATE INDEX government_forecast_check_time ON government_forecast_check(attempted_at DESC, id DESC);
CREATE UNIQUE INDEX government_forecast_failed_check_time ON government_forecast_check(attempted_at) WHERE status='failed';
CREATE TABLE government_forecast_observation (
  check_id bigint NOT NULL REFERENCES government_forecast_check(id),
  forecast_id text NOT NULL,
  revision integer NOT NULL,
  PRIMARY KEY (check_id, forecast_id),
  FOREIGN KEY (forecast_id, revision) REFERENCES government_forecast_revision(forecast_id, revision)
);
-- Preserve terminal identity even when the first observed edition has no forecast window.
CREATE TABLE government_forecast_terminal (
  source_key text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('withdrawn','source_completed')),
  check_id bigint NOT NULL REFERENCES government_forecast_check(id),
  evidence jsonb NOT NULL
);
COMMIT;
