-- Single-use, short-TTL WebSocket upgrade ticket.
--
-- Replaces putting the full Clerk JWT in the /intel-api/live query string and
-- retaining it on the connection for hours. The raw ticket is never stored,
-- only its SHA-256.

CREATE TABLE "intel_ws_ticket" (
    "id" TEXT NOT NULL,
    -- TEXT, not uuid: every intel_* tenant_id is TEXT and the RLS predicate
    -- casts current_tenant_id()::text. A uuid column here fails at runtime with
    -- PG 42883 "operator does not exist: text = uuid".
    "tenant_id" TEXT NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ticket_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "intel_ws_ticket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intel_ws_ticket_ticket_hash_key" ON "intel_ws_ticket"("ticket_hash");
CREATE INDEX "intel_ws_ticket_tenant_id_session_id_idx"
    ON "intel_ws_ticket"("tenant_id", "session_id");
CREATE INDEX "intel_ws_ticket_expires_at_idx" ON "intel_ws_ticket"("expires_at");

-- Tenant isolation, matching every other intel_* table.
--
-- The rls_bypass() branch is LOAD-BEARING, not boilerplate: the gateway must
-- read the ticket BEFORE it knows which tenant the connection belongs to, so
-- the consume path runs under withSystem. Without the bypass the UPDATE would
-- match zero rows — silently, not as an error — and every WebSocket connection
-- would fail with "invalid ticket".
ALTER TABLE "intel_ws_ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_ws_ticket" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_ws_ticket_isolation" ON "intel_ws_ticket";
CREATE POLICY "intel_ws_ticket_isolation" ON "intel_ws_ticket"
  USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_ws_ticket" TO capiro_app';
  END IF;
END $$;
