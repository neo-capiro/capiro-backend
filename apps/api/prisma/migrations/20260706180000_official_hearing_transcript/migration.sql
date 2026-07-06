-- Track B (H2): OFFICIAL published hearing transcript TEXT, ingested from GovInfo's
-- Congressional Hearings (CHRG) collection. Additive: a new table only, no change
-- to any existing column. GLOBAL public-record table — no tenant_id, no RLS (same
-- posture as committee_hearing; this is public government record, not tenant data).
-- Distinct from the machine (Deepgram) live transcript stored in intel-api.

CREATE TABLE "official_hearing_transcript" (
  "id"             TEXT           NOT NULL,
  "hearing_id"     TEXT,
  "source"         TEXT           NOT NULL DEFAULT 'govinfo',
  "congress"       INTEGER        NOT NULL,
  "chamber"        TEXT           NOT NULL,
  "committee_name" TEXT,
  "title"          TEXT           NOT NULL,
  "date"           DATE           NOT NULL,
  "source_url"     TEXT           NOT NULL,
  "format"         TEXT           NOT NULL DEFAULT 'txt',
  "text"           TEXT           NOT NULL,
  "char_count"     INTEGER        NOT NULL,
  "published_at"   TIMESTAMPTZ(6),
  "fetched_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "official_hearing_transcript_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "official_hearing_transcript_hearing_id_idx"
  ON "official_hearing_transcript" ("hearing_id");
CREATE INDEX "official_hearing_transcript_congress_chamber_date_idx"
  ON "official_hearing_transcript" ("congress", "chamber", "date");
CREATE INDEX "official_hearing_transcript_date_idx"
  ON "official_hearing_transcript" ("date");

-- Grant to the app role (same as other global sync-written tables); guarded so
-- it's a no-op where the role doesn't exist (e.g. a local superuser DB).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "official_hearing_transcript" TO capiro_app;
  END IF;
END
$$;
