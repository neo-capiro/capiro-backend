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

-- Explicit DML grant for the application role.
--
-- Belt and braces on purpose. Migration 20260502020000_capiro_app_role installs
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... ON TABLES TO capiro_app`,
-- and its own comment explains the assumption that makes it sufficient:
-- "Prisma migrations run as master, so future tables inherit ownership from
-- master and the default privileges grant capiro_app DML."
--
-- That assumption is not currently guaranteed by the deployment wiring, and
-- default privileges only apply to objects created by the role that set them.
-- If this migration is ever applied by a role other than capiro_master, the
-- table would be created with NO grant to capiro_app, and the seeder -- which
-- runs as capiro_app -- would fail with "permission denied" on every library
-- read. It fails soft, so the symptom would be starter templates silently never
-- appearing rather than a visible error.
--
-- An explicit grant costs nothing when the default privileges already cover it
-- (GRANT is idempotent) and makes this migration correct under either role.
-- Recent sibling migrations (e.g. 20271231040000_client_advocacy_matter) do the
-- same thing for the same reason.
GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_v3_template_seed_state TO capiro_app;
