-- WsDraft.clientId (1dac57e46) shipped in schema.prisma without its migration, so every
-- Workspace draft list fails with P2022 on databases built from these migrations.
-- Canonical Core client origin; Workspace keeps no cross-Core FK (see 20261012030000).
ALTER TABLE ws_draft ADD COLUMN client_id uuid;
CREATE INDEX ws_draft_client_idx ON ws_draft(tenant_id,client_id,updated_at);
