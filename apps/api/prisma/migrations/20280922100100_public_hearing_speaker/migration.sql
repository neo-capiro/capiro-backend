-- Resolved speaker identities for the one canonical public transcript per
-- hearing. GLOBAL (no tenant_id, no RLS), mirroring public_hearing_transcript_segment:
-- diarization labels ("0", "1", …) map to a display name once per capture.
CREATE TABLE "public_hearing_speaker" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "capture_id"    TEXT NOT NULL,
    "speaker_label" TEXT NOT NULL,
    "display_name"  TEXT NOT NULL,
    "role"          TEXT,
    "person_ref"    TEXT,
    "confidence"    DOUBLE PRECISION,
    "source"        TEXT NOT NULL,
    "updated_by"    TEXT,
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "public_hearing_speaker_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "public_hearing_speaker_capture_id_fkey"
      FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE,
    CONSTRAINT "public_hearing_speaker_source_check" CHECK ("source" IN ('llm', 'manual'))
);

CREATE UNIQUE INDEX "public_hearing_speaker_capture_id_speaker_label_key"
  ON "public_hearing_speaker" ("capture_id", "speaker_label");

ALTER TABLE "public_hearing_capture"
  ADD COLUMN "speakers_resolved_at" TIMESTAMPTZ(6),
  ADD COLUMN "speakers_resolved_through_sequence" INTEGER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "public_hearing_speaker" TO capiro_app;
  END IF;
END
$$;
