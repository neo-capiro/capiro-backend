-- Starter content templates: per-tenant seed marker.
--
-- The seven starter skeletons in
-- `apps/api/src/outreach-v3/templates/starter-content-templates.ts` are seeded
-- as ordinary `firm`-scope template rows, which that file states are
-- "editable and deletable like any user-authored template".
--
-- That is exactly why the marker cannot be the rows themselves. If seeding
-- decided what to do by looking for the starter rows, a tenant that deliberately
-- deleted or archived a starter would have it resurrected on the next read —
-- silently undoing a user's decision. This table records "this tenant has been
-- seeded at version N" independently of whether the rows still exist, so
-- deletion is permanent and seeding stays idempotent.
--
-- `seed_version` exists so a future revision of the starter SET can be rolled
-- out deliberately (bump STARTER_TEMPLATE_SEED_VERSION) without either
-- re-creating rows a tenant removed from the current version, or requiring a
-- data migration.

CREATE TABLE outreach_v3_template_seed_state (
  tenant_id    uuid PRIMARY KEY,
  seed_version integer NOT NULL,
  -- How many rows the seeding run actually inserted. Diagnostic only: a 0 here
  -- with a non-null seeded_at means "ran, found everything already present".
  created_count integer NOT NULL DEFAULT 0,
  seeded_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE outreach_v3_template_seed_state IS
  'Per-tenant marker that starter outreach content templates have been seeded. Deliberately separate from the template rows so a deleted starter is never resurrected.';

ALTER TABLE outreach_v3_template_seed_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_seed_state FORCE ROW LEVEL SECURITY;

-- Same canonical helpers the rest of the schema uses (current_tenant_id() /
-- rls_bypass(), defined in 20260501000000_init_identity_tenancy). There is no
-- per-user dimension to this row, so unlike the templates policy it has no
-- owner_user_id clause.
CREATE POLICY outreach_v3_template_seed_state_actor_policy ON outreach_v3_template_seed_state
  USING (
    rls_bypass()
    OR tenant_id = current_tenant_id()
  )
  WITH CHECK (
    rls_bypass()
    OR tenant_id = current_tenant_id()
  );
