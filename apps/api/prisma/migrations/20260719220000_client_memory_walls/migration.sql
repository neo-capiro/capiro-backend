-- Ethical walls, migration A of 2 (ADDITIVE ONLY — policy replacement ships
-- separately in 20260719221000_memory_wall_rls, per the 1A/1C/G2 split-
-- migration discipline: additive columns first, policy swap in its own step).
--
-- Master plan Phase 1 (Institutional Memory & Knowledge Graph, 2026-07-19):
-- upgrade client-scope memory from a RELEVANCE boundary (G2, 20260713020000 —
-- whose own comment records "no per-user client ACL exists in Capiro today")
-- to an ACCESS boundary a conflicted firm can rely on. Decision record:
-- docs/plans/2026-07-19-memory-ethical-walls-decision.md.
--
-- Model: Client.memory_wall (default FALSE) + client_memory_access grants.
-- DEFAULT-OFF BY CONSTRUCTION: with zero walled clients this migration and
-- the policy migration are provable no-ops for all existing data (same
-- shipping rationale as the expiry-RLS migration 20260713030000). A wall
-- begins to bind only when a user_admin sets memory_wall = true on a client.
-- Fail-closed: a walled client with zero grants is invisible to EVERYONE
-- (admins included — an ethical screen binds seniors too).

-- 1. The wall flag.
ALTER TABLE "clients" ADD COLUMN "memory_wall" BOOLEAN NOT NULL DEFAULT false;

-- Cheap "which clients are walled" scan for the app-side denied-set query
-- (partial index: the unwalled majority pays nothing).
CREATE INDEX "clients_memory_wall_idx"
  ON "clients" ("tenant_id")
  WHERE "memory_wall";

-- 2. The per-user grant table.
CREATE TABLE "client_memory_access" (
  "id"         UUID           NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"  UUID           NOT NULL,
  "client_id"  UUID           NOT NULL,
  "user_id"    UUID           NOT NULL,
  "granted_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "client_memory_access_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_memory_access_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "client_memory_access_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE,
  CONSTRAINT "client_memory_access_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "client_memory_access_uniq"
  ON "client_memory_access" ("tenant_id", "client_id", "user_id");
CREATE INDEX "client_memory_access_user_idx"
  ON "client_memory_access" ("tenant_id", "user_id");

-- RLS: tenant isolation, the standard pattern (20260501000000).
ALTER TABLE "client_memory_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_memory_access" FORCE ROW LEVEL SECURITY;

CREATE POLICY "client_memory_access_isolation" ON "client_memory_access"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "client_memory_access" TO capiro_app;
  END IF;
END
$$;

-- 3. context_embeddings.client_id parity backfill for memory_item rows
-- (mirrors 1C's owner_user_id backfill in 20260712030000). The policy
-- migration gates embedding rows by client_id; a memory-item embedding row
-- whose client identity was never stamped would silently escape the wall.
-- Idempotent: fills only NULLs from the canonical memory_items row.
--
-- ORPHAN GUARD (fix, 2026-07-20): memory_items.client_id may dangle — dev has
-- 83 memory_items pointing at hard-deleted clients. context_embeddings.client_id
-- carries a STRICT FK to clients (context_embeddings_client_fkey), so copying an
-- orphaned id would abort the whole migration (P3018 / 23503, seen on first dev
-- apply). Skip orphans: a client row that no longer exists cannot be walled
-- (the wall policy keys on an EXISTS(clients … memory_wall) that is false for a
-- missing client), so leaving those embedding rows client_id=NULL is the
-- correct, wall-safe outcome.
UPDATE "context_embeddings" ce
SET "client_id" = mi."client_id"
FROM "memory_items" mi
WHERE ce."source_type" = 'memory_item'
  AND ce."source_id" = mi."id"::text
  AND ce."client_id" IS NULL
  AND mi."client_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "clients" c WHERE c."id" = mi."client_id");
