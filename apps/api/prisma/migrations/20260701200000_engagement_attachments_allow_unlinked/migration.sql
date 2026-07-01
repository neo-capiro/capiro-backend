-- Client-free ("general outreach library") attachments are a first-class state:
-- files uploaded with no client/meeting/mail parent, tagged source='outreach',
-- reusable across campaigns and listed via GET /attachments?unlinked=true.
--
-- The original engagement_attachments_parent_check required at least one parent,
-- which 500s every parent-less confirm (Postgres 23514). Drop it so unlinked
-- rows are allowed. Tenant scoping (tenant_id NOT NULL) and the uploader FK still
-- constrain the row; the parent FKs remain (ON DELETE SET NULL/CASCADE) for the
-- linked case. Idempotent so re-applying is safe.
ALTER TABLE "engagement_attachments"
  DROP CONSTRAINT IF EXISTS "engagement_attachments_parent_check";
