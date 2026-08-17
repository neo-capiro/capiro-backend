-- Account owner is a tenant member assigned to a client.
-- Existing clients intentionally remain unassigned until a user_admin selects one.
ALTER TABLE "clients"
  ADD COLUMN "account_owner_user_id" UUID;

CREATE INDEX "clients_tenant_account_owner_idx"
  ON "clients"("tenant_id", "account_owner_user_id");

ALTER TABLE "clients"
  ADD CONSTRAINT "clients_account_owner_user_id_fkey"
  FOREIGN KEY ("account_owner_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
