CREATE TABLE intel_hearing_transcription_recovery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('browser','public')),
  epoch_id text NOT NULL, cursor_ms bigint NOT NULL DEFAULT 0 CHECK(cursor_ms>=0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','ready','failed')),
  token uuid, lease_until timestamptz, next_attempt timestamptz, attempts integer NOT NULL DEFAULT 0,
  recovered_segments integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kind,epoch_id)
);
CREATE INDEX hearing_transcription_recovery_due ON intel_hearing_transcription_recovery(state,next_attempt);
ALTER TABLE intel_hearing_transcription_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_transcription_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY hearing_transcription_recovery_worker ON intel_hearing_transcription_recovery
  USING(current_setting('app.bypass_rls',true)='on') WITH CHECK(current_setting('app.bypass_rls',true)='on');
GRANT SELECT,INSERT,UPDATE,DELETE ON intel_hearing_transcription_recovery TO capiro_app;
