-- Client file folders (Client CRM vNext, Figma 907:2810 / 907:3355).
--
-- Contract §12: "Moving changes folder/reference metadata. Do not unnecessarily
-- copy the stored object." So a folder is a column on the existing attachment
-- row — the S3 object is never re-uploaded, re-keyed or duplicated, and a file
-- referenced from a capability, strategy or meeting keeps ONE stored object.
--
-- NULL means the file is unfiled, which the UI shows as a real "Unfiled" group
-- rather than inventing a default folder name for historical rows.

ALTER TABLE engagement_attachments
  ADD COLUMN IF NOT EXISTS folder varchar(120) NULL;

-- Folder tree + per-folder counts are read per client.
CREATE INDEX IF NOT EXISTS engagement_attachments_client_folder_idx
  ON engagement_attachments (tenant_id, client_id, folder);
