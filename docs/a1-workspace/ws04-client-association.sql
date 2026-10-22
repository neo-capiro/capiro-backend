-- SQL proposal only: Fable assigns migration numbering and runs after snapshot.
-- No inferred name-based backfill. Explicit association is reviewed by its owner.
ALTER TABLE ws_draft ADD COLUMN client_id uuid NULL;
CREATE INDEX ws_draft_client_idx ON ws_draft(tenant_id, client_id, updated_at);
-- Existing JSON clientId-only rows remain held pending explicit owner association.
-- Deploy this migration before the Workspace image; capabilities stay off.
