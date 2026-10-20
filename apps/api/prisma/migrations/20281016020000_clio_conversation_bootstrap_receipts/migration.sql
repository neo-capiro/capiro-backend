-- A native Core conversation and its first-chat request key are committed in
-- one transaction. Keep the request key after conversation deletion so a
-- retry cannot silently allocate a replacement conversation.
CREATE TABLE "clio_conversation_bootstrap_receipts" (
  "tenant_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "conversation_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clio_bootstrap_receipts_pkey"
    PRIMARY KEY ("tenant_id", "actor_user_id", "request_id"),
  CONSTRAINT "clio_bootstrap_receipts_conversation_key"
    UNIQUE ("conversation_id"),
  CONSTRAINT "clio_bootstrap_receipts_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "clio_bootstrap_receipts_conversation_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "clio_conversations"("id") ON DELETE SET NULL
);

-- The only permitted update poisons a receipt after its conversation is hard
-- deleted. Ordinary API callers have no update or delete use for this ledger.
CREATE FUNCTION clio_bootstrap_receipt_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NULL
     AND NEW.tenant_id=OLD.tenant_id
     AND NEW.actor_user_id=OLD.actor_user_id
     AND NEW.request_id=OLD.request_id
     AND NEW.client_id=OLD.client_id
     AND NEW.created_at=OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Clio bootstrap receipt is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER clio_bootstrap_receipt_immutable
  BEFORE UPDATE ON "clio_conversation_bootstrap_receipts"
  FOR EACH ROW EXECUTE FUNCTION clio_bootstrap_receipt_update_guard();

ALTER TABLE "clio_conversation_bootstrap_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_conversation_bootstrap_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_bootstrap_receipts_isolation" ON "clio_conversation_bootstrap_receipts"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_conversation_bootstrap_receipts" FROM capiro_app;
    GRANT SELECT, INSERT ON "clio_conversation_bootstrap_receipts" TO capiro_app;
  END IF;
END $$;
