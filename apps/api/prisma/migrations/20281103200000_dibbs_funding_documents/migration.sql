-- Reuse public attachment storage; preserve all existing IDs and associations.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE opportunity_attachment ADD COLUMN dibbs_solicitation_id uuid;
ALTER TABLE opportunity_attachment DROP CONSTRAINT opportunity_attachment_parent_chk;
ALTER TABLE opportunity_attachment ADD CONSTRAINT opportunity_attachment_parent_chk
  CHECK (sam_opportunity_id IS NOT NULL OR tango_notice_id IS NOT NULL
    OR federal_grant_id IS NOT NULL OR dibbs_solicitation_id IS NOT NULL);
ALTER TABLE opportunity_attachment ADD CONSTRAINT opportunity_attachment_dibbs_parent_chk
  CHECK (dibbs_solicitation_id IS NULL OR
    (sam_opportunity_id IS NULL AND tango_notice_id IS NULL AND federal_grant_id IS NULL));
DROP INDEX opportunity_attachment_parent_url_uniq;
CREATE UNIQUE INDEX opportunity_attachment_parent_url_uniq ON opportunity_attachment
  (COALESCE(sam_opportunity_id::text,''), COALESCE(tango_notice_id,''),
   COALESCE(federal_grant_id,''), COALESCE(dibbs_solicitation_id::text,''), source_url);
CREATE INDEX opportunity_attachment_dibbs_idx ON opportunity_attachment(dibbs_solicitation_id,status);
COMMIT;
