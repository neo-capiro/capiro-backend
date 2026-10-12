ALTER TABLE ws_newsletter_asset
  ADD COLUMN revision_root_id uuid,
  ADD COLUMN revision_parent_id uuid,
  ADD COLUMN revision_number integer NOT NULL DEFAULT 1,
  ADD COLUMN current_revision boolean NOT NULL DEFAULT true;

ALTER TABLE ws_newsletter_asset
  ADD CONSTRAINT ws_newsletter_asset_scope_key UNIQUE (id, tenant_id, owner_id),
  ADD CONSTRAINT ws_newsletter_asset_revision_number_key UNIQUE (revision_root_id, revision_number),
  ADD CONSTRAINT ws_newsletter_asset_revision_root_scope_fkey
    FOREIGN KEY (revision_root_id, tenant_id, owner_id)
    REFERENCES ws_newsletter_asset (id, tenant_id, owner_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT ws_newsletter_asset_revision_parent_scope_fkey
    FOREIGN KEY (revision_parent_id, tenant_id, owner_id)
    REFERENCES ws_newsletter_asset (id, tenant_id, owner_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT ws_newsletter_asset_revision_shape_check CHECK (
    (revision_root_id IS NULL AND revision_parent_id IS NULL AND revision_number = 1)
    OR (revision_root_id IS NOT NULL AND revision_parent_id IS NOT NULL AND revision_number >= 2
        AND revision_root_id <> id AND revision_parent_id <> id)
  );

CREATE INDEX ws_newsletter_asset_tenant_id_owner_id_current_revision_deleted_at_idx
  ON ws_newsletter_asset (tenant_id, owner_id, current_revision, deleted_at);

CREATE UNIQUE INDEX ws_newsletter_asset_current_revision_key
  ON ws_newsletter_asset ((coalesce(revision_root_id, id)))
  WHERE current_revision AND deleted_at IS NULL;
