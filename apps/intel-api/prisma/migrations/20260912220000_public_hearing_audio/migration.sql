-- Global public capture identity remains API-owned. Audio is an Intel-owned
-- projection of that capture; tenant authorization is applied before playback.
CREATE TABLE intel_public_hearing_audio_epoch (
  id text PRIMARY KEY, capture_id uuid NOT NULL, hearing_id text NOT NULL, source_url text NOT NULL,
  owner_id text NOT NULL, fencing_token integer NOT NULL, start_ms bigint NOT NULL CHECK(start_ms>=0),
  durable_end_ms bigint NOT NULL, durable_bytes bigint NOT NULL DEFAULT 0, durable_sequence integer NOT NULL DEFAULT -1,
  sample_rate integer NOT NULL CHECK(sample_rate BETWEEN 8000 AND 48000), channels integer NOT NULL CHECK(channels BETWEEN 1 AND 2),
  state text NOT NULL DEFAULT 'recording' CHECK(state IN ('recording','ready','partial','expired')),
  transcript_state text NOT NULL DEFAULT 'streaming', reason text, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, UNIQUE(capture_id,fencing_token), CHECK(durable_end_ms>=start_ms)
);
CREATE TABLE intel_public_hearing_audio_part (
  id text PRIMARY KEY, epoch_id text NOT NULL REFERENCES intel_public_hearing_audio_epoch(id), sequence integer NOT NULL CHECK(sequence>=0),
  start_ms bigint NOT NULL, end_ms bigint NOT NULL CHECK(end_ms>start_ms), bytes integer NOT NULL CHECK(bytes>44 AND bytes<=1048576),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), object_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(epoch_id,sequence)
);
CREATE INDEX public_hearing_audio_epoch_hearing_idx ON intel_public_hearing_audio_epoch(hearing_id,created_at);
CREATE INDEX public_hearing_audio_epoch_expiry_idx ON intel_public_hearing_audio_epoch(expires_at,state);
-- These tables contain no tenant intelligence and are never exposed as a direct
-- data API. Only system capture workers may read/write; HTTP services authorize
-- the tenant's current event/source permission before system reads.
ALTER TABLE intel_public_hearing_audio_epoch ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_public_hearing_audio_epoch FORCE ROW LEVEL SECURITY;
ALTER TABLE intel_public_hearing_audio_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_public_hearing_audio_part FORCE ROW LEVEL SECURITY;
CREATE POLICY public_hearing_audio_worker ON intel_public_hearing_audio_epoch USING(current_setting('app.bypass_rls',true)='on') WITH CHECK(current_setting('app.bypass_rls',true)='on');
CREATE POLICY public_hearing_audio_part_worker ON intel_public_hearing_audio_part USING(current_setting('app.bypass_rls',true)='on') WITH CHECK(current_setting('app.bypass_rls',true)='on');
GRANT SELECT,INSERT,UPDATE,DELETE ON intel_public_hearing_audio_epoch,intel_public_hearing_audio_part TO capiro_app;
