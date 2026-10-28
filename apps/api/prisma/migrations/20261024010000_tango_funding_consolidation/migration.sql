-- Additive, global public-source storage. Preserve every canonical ID and all
-- tenant-owned workflow rows. Provider text is NOT a claim about archived bytes.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE opportunity_attachment
  ADD COLUMN federal_grant_id text,
  ADD COLUMN provider_attachment_id text,
  ADD COLUMN provider_data jsonb,
  ADD COLUMN provider_observed_at timestamptz,
  ADD COLUMN embedded_content_hash text, ADD COLUMN embedded_at timestamptz;
ALTER TABLE federal_grant ADD COLUMN embedded_content_hash text, ADD COLUMN embedded_at timestamptz;
ALTER TABLE sam_opportunity ADD COLUMN embedded_content_hash text, ADD COLUMN embedded_at timestamptz;

ALTER TABLE opportunity_attachment DROP CONSTRAINT opportunity_attachment_parent_chk;
ALTER TABLE opportunity_attachment ADD CONSTRAINT opportunity_attachment_parent_chk
  CHECK (sam_opportunity_id IS NOT NULL OR tango_notice_id IS NOT NULL OR federal_grant_id IS NOT NULL);
DROP INDEX opportunity_attachment_parent_url_uniq;
CREATE UNIQUE INDEX opportunity_attachment_parent_url_uniq ON opportunity_attachment
  (COALESCE(sam_opportunity_id::text,''), COALESCE(tango_notice_id,''), COALESCE(federal_grant_id,''), source_url);
CREATE UNIQUE INDEX opportunity_attachment_provider_uniq ON opportunity_attachment
  (sam_opportunity_id, provider_attachment_id) WHERE provider_attachment_id IS NOT NULL;
CREATE INDEX opportunity_attachment_grant_idx ON opportunity_attachment(federal_grant_id);
CREATE INDEX sam_opportunity_normalized_notice_idx ON sam_opportunity(lower(replace(notice_id,'-','')));

ALTER TABLE tango_resource_snapshot DROP CONSTRAINT tango_resource_snapshot_resource_type_chk;
ALTER TABLE tango_resource_snapshot ADD CONSTRAINT tango_resource_snapshot_resource_type_chk
  CHECK (resource_type IN ('entity','opportunity','notice','forecast','vehicle','vehicle_awardee','grant'));
ALTER TABLE tango_resource_link DROP CONSTRAINT tango_resource_link_tango_type_chk;
ALTER TABLE tango_resource_link ADD CONSTRAINT tango_resource_link_tango_type_chk
  CHECK (tango_resource_type IN ('entity','opportunity','notice','forecast','vehicle','vehicle_awardee','grant'));
ALTER TABLE tango_sync_checkpoint DROP CONSTRAINT tango_sync_checkpoint_resource_type_chk;
ALTER TABLE tango_sync_checkpoint ADD CONSTRAINT tango_sync_checkpoint_resource_type_chk
  CHECK (resource_type IN ('entity','opportunity','notice','forecast','vehicle','vehicle_awardee','grant'));
COMMIT;
