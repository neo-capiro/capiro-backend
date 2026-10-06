-- Bill-text search for Meri (Neo, 2026-10-06). Each stored BILLS revision is
-- indexed as overlapping 4,000-character windows (step 3,600, so a phrase never
-- falls between two windows) with a full-text vector. Windows keep Postgres's
-- 1 MB tsvector limit away from NDAA-sized bills. Text stays in
-- federal_evidence_revision; a passage stores only offsets and its vector.
CREATE TABLE "federal_evidence_passage" (
  "revision_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "start_offset" INTEGER NOT NULL,
  "end_offset" INTEGER NOT NULL,
  "tsv" TSVECTOR NOT NULL,
  CONSTRAINT "federal_evidence_passage_pkey" PRIMARY KEY ("revision_id", "ordinal"),
  CONSTRAINT "federal_evidence_passage_offsets_check"
    CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset"),
  CONSTRAINT "federal_evidence_passage_revision_id_fkey" FOREIGN KEY ("revision_id")
    REFERENCES "federal_evidence_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "federal_evidence_passage_tsv_idx" ON "federal_evidence_passage" USING GIN ("tsv");

CREATE FUNCTION federal_evidence_passage_index(revision UUID, body TEXT) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO federal_evidence_passage (revision_id, ordinal, start_offset, end_offset, tsv)
  SELECT revision,
         (window_start / 3600)::INTEGER,
         window_start,
         LEAST(length(body), window_start + 4000),
         to_tsvector('english', substr(body, window_start + 1, 4000))
    FROM generate_series(0, GREATEST(length(body) - 1, 0), 3600) AS window_start
  ON CONFLICT DO NOTHING;
$$;

CREATE FUNCTION federal_evidence_passage_on_revision() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.collection = 'BILLS' AND NEW.completeness = 'complete'
     AND length(NEW.extracted_text) > 0 THEN
    PERFORM federal_evidence_passage_index(NEW.id, NEW.extracted_text);
  END IF;
  RETURN NEW;
END
$$;

-- Created before the fill below: from here on inserts wait for this migration,
-- and each later revision is indexed by the trigger, so none is missed.
CREATE TRIGGER federal_evidence_revision_passages
  AFTER INSERT ON "federal_evidence_revision"
  FOR EACH ROW EXECUTE FUNCTION federal_evidence_passage_on_revision();

SELECT federal_evidence_passage_index(r.id, r.extracted_text)
  FROM "federal_evidence_revision" r
 WHERE r.collection = 'BILLS' AND r.completeness = 'complete'
   AND length(r.extracted_text) > 0;

-- Insert-only like the revision it indexes.
CREATE TRIGGER federal_evidence_passage_immutable
  BEFORE UPDATE OR DELETE ON "federal_evidence_passage"
  FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();

GRANT SELECT, INSERT ON "federal_evidence_passage" TO capiro_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "federal_evidence_passage" FROM capiro_app;
