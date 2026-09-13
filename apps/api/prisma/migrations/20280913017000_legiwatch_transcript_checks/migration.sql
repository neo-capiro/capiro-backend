CREATE TABLE official_hearing_transcript_check (
  package_id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('pending','success','failed')),
  checked_at TIMESTAMPTZ,attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),source_modified_at TEXT,last_error TEXT
);
GRANT SELECT,INSERT,UPDATE ON official_hearing_transcript_check TO capiro_app;
