-- Outreach V3 Phase 2: governed campaign templates.
--
-- Templates deliberately store reusable strategy/voice only. Published versions
-- are immutable, application is idempotent, and every applied session records
-- exact provenance.
--
-- Runtime isolation reality (read before touching this file): the deployed
-- `capiro_app` role is a member of the table-owner role and BYPASSES Postgres row-level security
-- (see PrismaService's own header comment and the 2026-07-16 incident it
-- documents). RLS below is defense in depth only — it
-- protects a direct psql session running as a non-owner role (e.g. an
-- RLS-enforced audit/read-replica role) and guards against a future role
-- change, but it is NOT the runtime boundary for `capiro_app` traffic. The
-- real runtime boundary is the explicit tenant/actor/scope/client predicate
-- in every raw SQL statement in outreach-template.repository.ts and the
-- server-side authorization in outreach-template.service.ts. Do not remove
-- those explicit predicates on the assumption RLS covers them.
--
-- Originally authored 2026-08-22; renamed to 2026-12-19 before first release
-- because `main` gained the `outreach_sessions` table (created in the
-- 2026-09-08 `outreach_v3_campaign_state` migration) after this branch was
-- cut. This migration's FKs to `outreach_sessions` require it to apply AFTER
-- that table exists, and Prisma applies migrations in strict timestamp
-- order — so the original 2026-08-22 name would fail on a fresh database.
-- This migration has never been applied to any non-disposable database, so
-- renaming (rather than adding a roll-forward migration) is safe.

CREATE TABLE outreach_v3_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  client_id uuid NULL,
  scope text NOT NULL CHECK (scope IN ('private', 'firm', 'client')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 1000),
  -- Free-text, bounded identity field (closeout runbook 4.1). Deliberately
  -- not a fixed enum: there is no existing Capiro-wide campaign-type
  -- taxonomy to encode, and inventing one here would be a fabricated
  -- category list. It is still indexed for filter/sort.
  campaign_type text NULL CHECK (campaign_type IS NULL OR char_length(campaign_type) <= 60),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  current_draft_version_id uuid NULL,
  published_version_id uuid NULL,
  -- Lineage only (closeout runbook 6.15): a duplicate is a fully independent
  -- template/version with its own identity and draft lifecycle. This never
  -- aliases the source's published pointer and is set once at creation.
  duplicated_from_template_id uuid NULL,
  duplicated_from_version_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  CONSTRAINT outreach_v3_templates_client_scope_ck CHECK (
    (scope = 'client' AND client_id IS NOT NULL) OR
    (scope <> 'client' AND client_id IS NULL)
  ),
  -- Same-template/same-tenant/same-lifecycle pointer integrity (added below via
  -- composite FKs) needs a composite unique target on this table.
  CONSTRAINT outreach_v3_templates_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE TABLE outreach_v3_template_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES outreach_v3_templates(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  -- 'superseded': a draft that lost the current-draft pointer to a newer
  -- draft without ever being published (closeout runbook 6.17) — draft
  -- content rows are append-only, so replacing a draft's content always
  -- creates a new version rather than mutating this one in place.
  lifecycle text NOT NULL CHECK (lifecycle IN ('draft', 'published', 'superseded')),
  template_spec_jsonb jsonb NOT NULL CHECK (octet_length(template_spec_jsonb::text) <= 200000),
  content_hash text NOT NULL CHECK (char_length(content_hash) = 64),
  source_session_id uuid NULL,
  source_state_version integer NULL CHECK (source_state_version IS NULL OR source_state_version > 0),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL,
  UNIQUE (template_id, version_number),
  CONSTRAINT outreach_v3_template_versions_publish_ck CHECK (
    (lifecycle = 'published' AND published_at IS NOT NULL) OR
    (lifecycle IN ('draft', 'superseded') AND published_at IS NULL)
  ),
  -- Referenced by composite FKs from outreach_v3_templates (draft/published
  -- pointers) and outreach_v3_template_applications so a pointer cannot name
  -- a version belonging to a different template or tenant.
  CONSTRAINT outreach_v3_template_versions_id_tenant_template_unique
    UNIQUE (id, tenant_id, template_id),
  -- MATCH SIMPLE (Postgres default): a NULL source_session_id skips this FK
  -- entirely, which is correct for from-scratch templates. When present, it
  -- must belong to the SAME tenant as this version (integrity item 3.6-6).
  CONSTRAINT outreach_v3_template_versions_source_session_fk
    FOREIGN KEY (source_session_id, tenant_id)
    REFERENCES outreach_sessions(id, tenant_id)
    ON DELETE SET NULL
);

ALTER TABLE outreach_v3_templates
  ADD CONSTRAINT outreach_v3_templates_draft_fk
  FOREIGN KEY (current_draft_version_id, tenant_id, id)
  REFERENCES outreach_v3_template_versions(id, tenant_id, template_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE outreach_v3_templates
  ADD CONSTRAINT outreach_v3_templates_published_fk
  FOREIGN KEY (published_version_id, tenant_id, id)
  REFERENCES outreach_v3_template_versions(id, tenant_id, template_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- Client scope must resolve to a real client in the SAME tenant. clients has
-- no pre-existing (id, tenant_id) uniqueness target, so add one — it is
-- always satisfiable because id is already a primary key.
ALTER TABLE clients
  ADD CONSTRAINT clients_id_tenant_unique UNIQUE (id, tenant_id);

ALTER TABLE outreach_v3_templates
  ADD CONSTRAINT outreach_v3_templates_client_fk
  FOREIGN KEY (client_id, tenant_id)
  REFERENCES clients(id, tenant_id)
  ON DELETE RESTRICT;

-- Duplicate lineage (closeout runbook 6.15): informational only, never a
-- live pointer another mutation depends on, so ON DELETE SET NULL is safe —
-- deleting the source template must not block or cascade into its copies.
ALTER TABLE outreach_v3_templates
  ADD CONSTRAINT outreach_v3_templates_duplicated_from_fk
  FOREIGN KEY (duplicated_from_version_id, tenant_id, duplicated_from_template_id)
  REFERENCES outreach_v3_template_versions(id, tenant_id, template_id)
  ON DELETE SET NULL,
  ADD CONSTRAINT outreach_v3_templates_duplicated_from_pair_ck CHECK (
    (duplicated_from_template_id IS NULL AND duplicated_from_version_id IS NULL) OR
    (duplicated_from_template_id IS NOT NULL AND duplicated_from_version_id IS NOT NULL)
  );

CREATE TABLE outreach_v3_template_applications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  session_id uuid NOT NULL,
  applied_by_user_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (char_length(request_fingerprint) = 64),
  command_batch_jsonb jsonb NOT NULL CHECK (octet_length(command_batch_jsonb::text) <= 262144),
  template_content_hash text NOT NULL CHECK (char_length(template_content_hash) = 64),
  resulting_state_version integer NOT NULL CHECK (resulting_state_version > 0),
  -- Durable application receipt (closeout runbook 5): exactly what was
  -- inherited/refreshed/unresolved/unavailable at apply time, so the UI can
  -- show it again later without recomputing it from scratch. Immutable, like
  -- every other column on this append-only table.
  receipt_jsonb jsonb NOT NULL CHECK (octet_length(receipt_jsonb::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, applied_by_user_id, request_key),
  UNIQUE (session_id),
  -- Referenced by outreach_v3_session_template_provenance so provenance
  -- cannot name a template/version pair that does not match this application.
  CONSTRAINT outreach_v3_template_applications_id_tenant_tv_unique
    UNIQUE (id, tenant_id, template_id, template_version_id),
  -- The applied version must belong to the applied template AND this
  -- application's own tenant (integrity item 3.6-4).
  CONSTRAINT outreach_v3_template_applications_version_fk
    FOREIGN KEY (template_version_id, tenant_id, template_id)
    REFERENCES outreach_v3_template_versions(id, tenant_id, template_id)
    ON DELETE RESTRICT,
  CONSTRAINT outreach_v3_template_applications_template_fk
    FOREIGN KEY (template_id, tenant_id)
    REFERENCES outreach_v3_templates(id, tenant_id)
    ON DELETE RESTRICT,
  -- Source session must belong to the same tenant as the application.
  CONSTRAINT outreach_v3_template_applications_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES outreach_sessions(id, tenant_id)
    ON DELETE CASCADE
);

CREATE TABLE outreach_v3_session_template_provenance (
  session_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  application_id uuid NOT NULL UNIQUE,
  applied_by_user_id uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  -- Session provenance must match its application's own tenant/template/
  -- version exactly (integrity item 3.6-5) — a single composite FK proves all
  -- four line up simultaneously, not just pairwise.
  CONSTRAINT outreach_v3_session_template_provenance_application_fk
    FOREIGN KEY (application_id, tenant_id, template_id, template_version_id)
    REFERENCES outreach_v3_template_applications(id, tenant_id, template_id, template_version_id)
    ON DELETE CASCADE,
  CONSTRAINT outreach_v3_session_template_provenance_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES outreach_sessions(id, tenant_id)
    ON DELETE CASCADE
);

-- Append-only, safe-metadata-only audit trail for template lifecycle actions,
-- including denied attempts. Confidential spec content (goals, style samples,
-- campaign angle, etc.) must never be written here — only identifiers, scope,
-- action, and outcome.
CREATE TABLE outreach_v3_template_audit_log (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN (
    'create', 'create_version', 'publish', 'update_metadata',
    'archive', 'restore', 'duplicate', 'use', 'denied'
  )),
  template_id uuid NULL,
  template_version_id uuid NULL,
  scope text NULL CHECK (scope IS NULL OR scope IN ('private', 'firm', 'client')),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  reason_code text NULL CHECK (reason_code IS NULL OR char_length(reason_code) <= 80),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(safe_metadata::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outreach_v3_templates_tenant_status_idx
  ON outreach_v3_templates (tenant_id, status, updated_at DESC);
CREATE INDEX outreach_v3_templates_client_idx
  ON outreach_v3_templates (tenant_id, client_id, updated_at DESC)
  WHERE client_id IS NOT NULL;
CREATE INDEX outreach_v3_templates_owner_idx
  ON outreach_v3_templates (tenant_id, owner_user_id, updated_at DESC)
  WHERE scope = 'private';
CREATE INDEX outreach_v3_templates_campaign_type_idx
  ON outreach_v3_templates (tenant_id, campaign_type, updated_at DESC)
  WHERE campaign_type IS NOT NULL;
CREATE INDEX outreach_v3_template_versions_template_idx
  ON outreach_v3_template_versions (template_id, version_number DESC);
CREATE INDEX outreach_v3_template_applications_template_idx
  ON outreach_v3_template_applications (template_id, created_at DESC);
CREATE INDEX outreach_v3_template_applications_usage_idx
  ON outreach_v3_template_applications (tenant_id, template_id, created_at DESC);
CREATE INDEX outreach_v3_session_template_provenance_template_idx
  ON outreach_v3_session_template_provenance (tenant_id, template_id, applied_at DESC);
CREATE INDEX outreach_v3_template_audit_log_tenant_created_idx
  ON outreach_v3_template_audit_log (tenant_id, created_at DESC);
CREATE INDEX outreach_v3_template_audit_log_template_idx
  ON outreach_v3_template_audit_log (template_id, created_at DESC)
  WHERE template_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_outreach_v3_published_template_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.lifecycle = 'published' THEN
    RAISE EXCEPTION 'Published outreach template versions are immutable.' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.lifecycle = 'published' THEN
    RAISE EXCEPTION 'Published outreach template versions are immutable.' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER outreach_v3_template_versions_immutable
BEFORE UPDATE OR DELETE ON outreach_v3_template_versions
FOR EACH ROW EXECUTE FUNCTION prevent_outreach_v3_published_template_mutation();

-- Applications and session provenance are append-only records: no code path
-- ever legitimately updates or deletes them (a losing idempotent race replays
-- the winner rather than mutating anything). A trigger is used instead of
-- relying solely on the GRANT list below because triggers fire unconditionally
-- for every writer regardless of role membership or RLS bypass status, so this
-- holds even under the RLS-bypassing `capiro_app` connection.
CREATE OR REPLACE FUNCTION prevent_outreach_v3_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only and cannot be updated or deleted.', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER outreach_v3_template_applications_append_only
BEFORE UPDATE OR DELETE ON outreach_v3_template_applications
FOR EACH ROW EXECUTE FUNCTION prevent_outreach_v3_append_only_mutation();

CREATE TRIGGER outreach_v3_session_template_provenance_append_only
BEFORE UPDATE OR DELETE ON outreach_v3_session_template_provenance
FOR EACH ROW EXECUTE FUNCTION prevent_outreach_v3_append_only_mutation();

CREATE TRIGGER outreach_v3_template_audit_log_append_only
BEFORE UPDATE OR DELETE ON outreach_v3_template_audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_outreach_v3_append_only_mutation();

ALTER TABLE outreach_v3_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_applications FORCE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_session_template_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_session_template_provenance FORCE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_audit_log FORCE ROW LEVEL SECURITY;

-- Use the SAME canonical helper functions the rest of the schema already
-- uses for RLS (current_tenant_id() / current_user_id() / rls_bypass(),
-- defined in 20260501000000_init_identity_tenancy and
-- 20260712030000_memory_items_private_scope_rls) rather than re-deriving
-- app.current_tenant / app.current_user inline. Two reasons beyond
-- consistency: (1) these are the exact GUC names PrismaService.withTenant()/
-- withTenantUser() set (apps/api/src/prisma/prisma.service.ts) — the
-- previous draft of this migration used app.current_firm_id /
-- app.current_user_id, which PrismaService never sets, so those policies
-- silently never matched any real connection; (2) rls_bypass() also honors
-- app.bypass_rls, which PrismaService.withSystem() sets for trusted
-- cross-tenant admin paths — a detail a hand-rolled current_setting() policy
-- would otherwise have to duplicate or, as here originally, omit entirely.
-- outreach-template.persistence.spec.ts fails the build if either legacy GUC
-- name reappears in a current_setting(...) call in this file.
CREATE POLICY outreach_v3_templates_actor_policy ON outreach_v3_templates
  USING (
    rls_bypass()
    OR (
      tenant_id = current_tenant_id()
      AND (scope <> 'private' OR owner_user_id = current_user_id())
    )
  )
  WITH CHECK (
    rls_bypass()
    OR (tenant_id = current_tenant_id() AND owner_user_id = current_user_id())
  );

CREATE POLICY outreach_v3_template_versions_actor_policy ON outreach_v3_template_versions
  USING (
    rls_bypass()
    OR (
      tenant_id = current_tenant_id()
      AND EXISTS (
        SELECT 1 FROM outreach_v3_templates t
        WHERE t.id = template_id
          AND t.tenant_id = tenant_id
          AND (t.scope <> 'private' OR t.owner_user_id = current_user_id())
      )
    )
  )
  WITH CHECK (
    rls_bypass()
    OR (tenant_id = current_tenant_id() AND created_by_user_id = current_user_id())
  );

CREATE POLICY outreach_v3_template_applications_actor_policy ON outreach_v3_template_applications
  USING (
    rls_bypass()
    OR (tenant_id = current_tenant_id() AND applied_by_user_id = current_user_id())
  )
  WITH CHECK (
    rls_bypass()
    OR (tenant_id = current_tenant_id() AND applied_by_user_id = current_user_id())
  );

CREATE POLICY outreach_v3_session_template_provenance_actor_policy ON outreach_v3_session_template_provenance
  USING (
    rls_bypass()
    OR (tenant_id = current_tenant_id() AND applied_by_user_id = current_user_id())
  )
  WITH CHECK (
    rls_bypass()
    OR (tenant_id = current_tenant_id() AND applied_by_user_id = current_user_id())
  );

CREATE POLICY outreach_v3_template_audit_log_actor_policy ON outreach_v3_template_audit_log
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (
    rls_bypass()
    OR (tenant_id = current_tenant_id() AND actor_user_id = current_user_id())
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    -- templates/versions: no legitimate DELETE path (archive is a soft-delete
    -- status flip); versions additionally have the immutability trigger above
    -- for already-published rows.
    GRANT SELECT, INSERT, UPDATE ON outreach_v3_templates TO capiro_app;
    GRANT SELECT, INSERT, UPDATE ON outreach_v3_template_versions TO capiro_app;
    -- applications/provenance/audit log: append-only. UPDATE/DELETE are
    -- withheld at the GRANT level in addition to the triggers above.
    GRANT SELECT, INSERT ON outreach_v3_template_applications TO capiro_app;
    GRANT SELECT, INSERT ON outreach_v3_session_template_provenance TO capiro_app;
    GRANT SELECT, INSERT ON outreach_v3_template_audit_log TO capiro_app;
  END IF;
END;
$$;
