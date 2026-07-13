-- G2 migration B — DB-boundary expiry for ephemeral memory (blueprint §5.4
-- "task-only / ephemeral … automatically expired").
--
-- Replaces the 1C owner-aware memory_items policy with the same policy PLUS
-- an expiry predicate: an expired row is unreadable AT THE DATABASE BOUNDARY
-- even if some future reader forgets the app-level filter — the same
-- fail-closed doctrine as 1C's private-scope enforcement.
--
-- Risk note (why this may ship in the same deploy as migration A, unlike the
-- 1C rollout which required its own clone-rehearsed window): at apply time
-- ZERO rows have expires_at set (the column is brand-new, all NULL), so the
-- new predicate `expires_at IS NULL OR expires_at > now()` admits every
-- existing row — the policy replacement is a provable no-op for all current
-- data. It only begins to bite as ephemeral rows are written and age out.
--
-- Semantics: USING gates row VISIBILITY for SELECT/UPDATE/DELETE, so once a
-- row expires it is gone from every non-bypass path — including the 1D verbs
-- (a forget/correct addressing an expired id 404s; acceptable for working
-- memory that the purge sweep erases under rls_bypass shortly after). WITH
-- CHECK does not carry the expiry predicate: it gates NEW row values, and
-- inserting a not-yet-expired ephemeral row must remain legal.
DROP POLICY "memory_items_isolation" ON "memory_items";
CREATE POLICY "memory_items_isolation" ON "memory_items"
  USING (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (visibility = 'tenant' OR owner_user_id = current_user_id())
      AND (expires_at IS NULL OR expires_at > now())
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (visibility = 'tenant' OR owner_user_id = current_user_id())
    )
  );
