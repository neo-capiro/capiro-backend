BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX "mail_messages_tenant_connection_active_idx"
  ON "mail_messages" ("tenant_id", "connection_id")
  WHERE "removed_at" IS NULL;

COMMIT;
