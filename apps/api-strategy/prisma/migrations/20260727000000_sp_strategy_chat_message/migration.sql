-- Prototype Phase 2 — the durable contextual Meri conversation (additive only).
--
-- One thread per context on a strategy: the strategy itself (node_id IS NULL) and
-- one per step (node_id set). Replaces the ephemeral in-memory rail transcript, so
-- a reload or a context switch no longer discards what Meri and the user said.
--
-- Two deliberate shape decisions, both load-bearing:
--
-- 1. node_id has NO foreign key. A version restore ARCHIVES the steps its snapshot
--    omits (P0-1 soft delete) and a manual delete removes them outright; either
--    with an FK would cascade the step's whole conversation away. The thread must
--    outlive the step, so the column is a bare UUID and the service validates it
--    against sp_node (live OR archived) at read/write time.
--
-- 2. (tenant_id, client_message_id) is UNIQUE. The web mints one UUID per user
--    send, so a retried POST — the network dropped the response, the user hit
--    send twice — reuses the stored message instead of double-posting it.
--    client_message_id is NULLable and Postgres treats NULLs as distinct, so the
--    server-authored rows (Meri replies, context gaps) are unconstrained.
--
-- role/kind/state are TEXT with service-validated closed sets rather than enums:
-- Phase 4 adds Watch kinds and Phase 5 adds gap states, no index or constraint
-- keys off them, and an ALTER TYPE per phase would buy nothing.
--
-- DDL generated via `prisma migrate diff` empty→schema; the RLS block is
-- hand-written to match 20260722000000_init_strategy's idiom (the GUC helpers
-- current_tenant_id()/rls_bypass() already exist from G1). Same standing caveat as
-- every other sp_* table: capiro_app currently BYPASSES RLS, so the policy is the
-- forward-ready DB boundary and the real isolation is the withTenant query hook.
--
-- ROLLBACK (manual, forward-only migrate; nothing else references the table):
--   DROP TABLE IF EXISTS "sp_strategy_chat_message" CASCADE;

-- CreateTable
CREATE TABLE "sp_strategy_chat_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "node_id" UUID,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "body" TEXT NOT NULL,
    "attachment_refs" JSONB,
    "action" JSONB,
    "state" TEXT NOT NULL DEFAULT 'active',
    "client_message_id" UUID,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sp_strategy_chat_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The one read this table serves: "every message in this context, oldest first".
-- node_id sits inside the prefix so the strategy thread (IS NULL) and each step
-- thread are separate ranges rather than one scan filtered in memory.
CREATE INDEX "sp_strategy_chat_message_tenant_id_strategy_id_node_id_crea_idx" ON "sp_strategy_chat_message"("tenant_id", "strategy_id", "node_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sp_strategy_chat_message_tenant_id_client_message_id_key" ON "sp_strategy_chat_message"("tenant_id", "client_message_id");

-- AddForeignKey
ALTER TABLE "sp_strategy_chat_message" ADD CONSTRAINT "sp_strategy_chat_message_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "sp_strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-Level Security (same tenant-isolation policy as every other sp_* table).
-- ---------------------------------------------------------------------------

ALTER TABLE "sp_strategy_chat_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_strategy_chat_message" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_strategy_chat_message_isolation" ON "sp_strategy_chat_message"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
