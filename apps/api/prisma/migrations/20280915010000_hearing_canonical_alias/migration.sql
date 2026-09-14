-- Additive only. No production hearing is merged by this migration.
ALTER TABLE "committee_hearing"
  ADD COLUMN "canonical_hearing_id" TEXT,
  ADD COLUMN "alias_evidence" JSONB,
  ADD COLUMN "aliased_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "committee_hearing_canonical_hearing_id_fkey"
    FOREIGN KEY ("canonical_hearing_id") REFERENCES "committee_hearing"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "committee_hearing_alias_evidence_check" CHECK (
    (canonical_hearing_id IS NULL AND alias_evidence IS NULL AND aliased_at IS NULL)
    OR (canonical_hearing_id IS NOT NULL AND canonical_hearing_id <> id
        AND alias_evidence IS NOT NULL AND aliased_at IS NOT NULL)
  );
CREATE INDEX "committee_hearing_canonical_hearing_id_idx" ON "committee_hearing"("canonical_hearing_id");

-- Preserve the existing view's column order, grant and invoker security. New
-- nullable columns append at the end; aliases are excluded before SQL paging
-- and counts in archive, recording and other legacy federal consumers.
CREATE OR REPLACE VIEW federal_committee_hearing WITH (security_invoker = true) AS
SELECT * FROM committee_hearing
WHERE (geographic_jurisdiction = 'US' OR geographic_jurisdiction IS NULL)
  AND canonical_hearing_id IS NULL;
