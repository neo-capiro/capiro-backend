-- Ethical walls, migration B of 2 — wall-aware RLS policy replacement for the
-- three memory read surfaces (clio_memory, memory_items, context_embeddings).
-- Additive columns/table shipped in 20260719220000_client_memory_walls.
--
-- PROVABLE NO-OP AT APPLY TIME: every predicate below collapses to the prior
-- policy while zero clients have memory_wall = true (the column ships
-- default-false and only a user_admin can set it). Same shipping rationale as
-- the expiry-RLS swap (20260713030000). It begins to bite per client, when a
-- wall is erected.
--
-- Semantics (USING only — read gating). WITH CHECK is left exactly as before:
-- writes into a walled client's memory remain governed by the candidate
-- approval flow at the application layer, and the system projection runs
-- under rls_bypass. A walled row is readable when:
--   * the client is not walled, OR
--   * current_user_id() has a client_memory_access grant for that client.
-- current_user_id() IS NULL (a withTenant caller that never identified the
-- user) gets NO walled rows — fail-closed by construction. The recall call
-- sites that legitimately serve a user are converted to withTenantUser in the
-- same deploy (sweep tracked in memory-wall-fail-closed.spec.ts, mirroring
-- the 1C conversion discipline).
--
-- ⚠️ RUNTIME CAVEAT (dev-proven 2026-07-19, ledger "RLS-bypass finding"):
-- the live app role capiro_app currently defeats ALL RLS on these tables via
-- owner-role membership (SET ROLE capiro_app read every tenant's rows with no
-- GUC set, FORCE notwithstanding). Until the role-hardening remediation lands
-- (tracked separately; requires Neo's approval — auth-adjacent), the wall is
-- ENFORCED by the application-layer denied-client predicates that ship with
-- this migration, and these policies are the forward-ready DB boundary they
-- become the moment the role is fixed. Do NOT treat this migration alone as
-- "DB-enforced".

-- ── clio_memory ─────────────────────────────────────────────────────────────
DROP POLICY "clio_memory_isolation" ON "clio_memory";
CREATE POLICY "clio_memory_isolation" ON "clio_memory"
  USING (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (
        scope <> 'client'
        OR NOT EXISTS (
          SELECT 1 FROM clients c
          WHERE c.id = clio_memory.client_id
            AND c.tenant_id = clio_memory.tenant_id
            AND c.memory_wall
        )
        OR EXISTS (
          SELECT 1 FROM client_memory_access a
          WHERE a.tenant_id = clio_memory.tenant_id
            AND a.client_id = clio_memory.client_id
            AND a.user_id = current_user_id()
        )
      )
    )
  )
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── memory_items (extends the 1C owner + expiry policy) ────────────────────
DROP POLICY "memory_items_isolation" ON "memory_items";
CREATE POLICY "memory_items_isolation" ON "memory_items"
  USING (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (visibility = 'tenant' OR owner_user_id = current_user_id())
      AND (expires_at IS NULL OR expires_at > now())
      AND (
        client_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM clients c
          WHERE c.id = memory_items.client_id
            AND c.tenant_id = memory_items.tenant_id
            AND c.memory_wall
        )
        OR EXISTS (
          SELECT 1 FROM client_memory_access a
          WHERE a.tenant_id = memory_items.tenant_id
            AND a.client_id = memory_items.client_id
            AND a.user_id = current_user_id()
        )
      )
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (visibility = 'tenant' OR owner_user_id = current_user_id())
    )
  );

-- ── context_embeddings (extends the 1C owner-aware policy) ──────────────────
-- client_id is stamped on memory_item-sourced rows (backfilled in migration A;
-- projectClioMemory/embedAndUpsert stamp it going forward) and NULL on global
-- reference rows (bills, LDA, capabilities…), so the wall clause is a no-op
-- for every non-client row.
DROP POLICY "context_embeddings_isolation" ON "context_embeddings";
CREATE POLICY "context_embeddings_isolation" ON "context_embeddings"
  USING (
    rls_bypass() OR tenant_id IS NULL OR (
      tenant_id = current_tenant_id()
      AND (owner_user_id IS NULL OR owner_user_id = current_user_id())
      AND (
        client_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM clients c
          WHERE c.id = context_embeddings.client_id
            AND c.tenant_id = context_embeddings.tenant_id
            AND c.memory_wall
        )
        OR EXISTS (
          SELECT 1 FROM client_memory_access a
          WHERE a.tenant_id = context_embeddings.tenant_id
            AND a.client_id = context_embeddings.client_id
            AND a.user_id = current_user_id()
        )
      )
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (owner_user_id IS NULL OR owner_user_id = current_user_id())
    )
  );
