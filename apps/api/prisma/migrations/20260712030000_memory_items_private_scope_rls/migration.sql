-- Phase 1 ("One Memory, One Ledger") workstream 1C — structural private-scope
-- enforcement (3a -> 3b upgrade). Blueprint gate: "do not position
-- institutional memory as a moat until private scopes are database-enforced"
-- (§12.5 #1). Today memory_items RLS is TENANT-only; the owner/visibility
-- check lives only in application code (memory-store.service.ts's manual
-- `(visibility = 'tenant' OR owner_user_id = $userId)` clause). This
-- migration moves that predicate to the database boundary, mirroring the
-- exact current_tenant_id()/rls_bypass() GUC pattern (20260501000000).
--
-- HIGHEST-RISK MIGRATION IN PHASE 1. Do not apply to prod without first:
--   1. Clone-rehearsing on an Aurora copy-on-write clone (same playbook as
--      the clio_memory RLS rollout, 2026-07-05).
--   2. Confirming EVERY apps/api caller that reads/writes memory_items now
--      sets app.current_user via withTenantUser (prisma.service.ts) — a
--      caller that forgets it silently gets ZERO rows for private items
--      instead of an error. The caller-conversion sweep for this migration
--      is tracked in the Phase 1 deployment plan (workstream 1C, 7 verified
--      call sites) and must land in the SAME deploy as this migration.
--   3. Running the post-deploy canary (docs/plans plan §7/§10) for one full
--      traffic cycle before declaring 1C shipped (G7 exit-gate criterion).

-- ── current_user_id(): third GUC, mirrors current_tenant_id() exactly ──────
CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
DECLARE
  v_raw TEXT := current_setting('app.current_user', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ── memory_items: replace the tenant-only policy with an owner-aware one ──
-- Safe by construction: memory_items_owner_visibility_chk (existing,
-- 20260625130000) already guarantees owner_user_id IS NULL whenever
-- visibility='tenant', so a shared item always matches the first OR-branch
-- regardless of current_user_id().
DROP POLICY "memory_items_isolation" ON "memory_items";
CREATE POLICY "memory_items_isolation" ON "memory_items"
  USING (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (visibility = 'tenant' OR owner_user_id = current_user_id())
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (visibility = 'tenant' OR owner_user_id = current_user_id())
    )
  );

-- ── context_embeddings: same predicate for memory_item-sourced rows ────────
-- owner_user_id is NULL for every non-memory_item row (bills, LDA filings,
-- capabilities, etc.) and for tenant-shared memory items, so this predicate
-- is a no-op for all of them; only a private memory item's own embedding row
-- is newly gated.
ALTER TABLE "context_embeddings" ADD COLUMN "owner_user_id" UUID;

UPDATE "context_embeddings" ce
SET "owner_user_id" = mi.owner_user_id
FROM "memory_items" mi
WHERE ce.source_type = 'memory_item'
  AND ce.source_id = mi.id::text
  AND mi.owner_user_id IS NOT NULL;

DROP POLICY "context_embeddings_isolation" ON "context_embeddings";
CREATE POLICY "context_embeddings_isolation" ON "context_embeddings"
  USING (
    rls_bypass() OR tenant_id IS NULL OR (
      tenant_id = current_tenant_id()
      AND (owner_user_id IS NULL OR owner_user_id = current_user_id())
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (owner_user_id IS NULL OR owner_user_id = current_user_id())
    )
  );
