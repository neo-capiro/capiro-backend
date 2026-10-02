-- The canonical mail count/page join checks the caller's owned connection,
-- tenant, thread identity and optional client. The previous tenant/client/time
-- index required a large thread heap walk even when one mailbox was selected.
-- Keep all query and RLS predicates unchanged; cover only the existing join.
--
-- A normal index build permits reads but briefly blocks writes to this table.
-- Bound lock acquisition and the entire build; transaction rollback removes
-- any partial result. Do not precreate or silently accept an invalid index.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX "mail_threads_tenant_connection_id_cover_idx"
  ON "mail_threads" ("tenant_id", "connection_id", "id")
  INCLUDE ("client_id");

COMMIT;
