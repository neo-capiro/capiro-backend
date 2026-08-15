-- Knowledge Plane — Phase 5B canonical entity merge lineage.
--
-- A tenant-private placeholder may be created before a reviewed public source
-- establishes the real global identity. Convergence must not rewrite history:
-- the old canonical entity remains, marked merged; its identity links are
-- withdrawn/re-appended to the target; and this append-only ledger records why.

CREATE TABLE "canonical_entity_merges" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "source_entity_id" UUID NOT NULL,
  "target_entity_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "reason_code" VARCHAR(64) NOT NULL,
  "reason" TEXT,
  "provenance" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "canonical_entity_merges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_entity_merges_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "canonical_entity_merges_source_fkey"
    FOREIGN KEY ("source_entity_id") REFERENCES "canonical_entities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "canonical_entity_merges_target_fkey"
    FOREIGN KEY ("target_entity_id") REFERENCES "canonical_entities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "canonical_entity_merges_source_unique"
    UNIQUE ("source_entity_id"),
  CONSTRAINT "canonical_entity_merges_distinct_check"
    CHECK ("source_entity_id" <> "target_entity_id"),
  CONSTRAINT "canonical_entity_merges_reason_code_check"
    CHECK ("reason_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "canonical_entity_merges_provenance_check"
    CHECK (jsonb_typeof("provenance") = 'array')
);

CREATE INDEX "canonical_entity_merges_tenant_created_idx"
  ON "canonical_entity_merges" ("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "canonical_entity_merges_target_idx"
  ON "canonical_entity_merges" ("tenant_id", "target_entity_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION enforce_canonical_entity_merge_record()
RETURNS trigger AS $$
DECLARE
  v_source_scope TEXT;
  v_source_tenant UUID;
  v_source_type TEXT;
  v_source_status TEXT;
  v_target_scope TEXT;
  v_target_tenant UUID;
  v_target_type TEXT;
  v_target_status TEXT;
BEGIN
  SELECT identity_scope, tenant_id, entity_type, status
    INTO v_source_scope, v_source_tenant, v_source_type, v_source_status
  FROM canonical_entities
  WHERE id = NEW.source_entity_id;

  SELECT identity_scope, tenant_id, entity_type, status
    INTO v_target_scope, v_target_tenant, v_target_type, v_target_status
  FROM canonical_entities
  WHERE id = NEW.target_entity_id;

  IF v_source_scope <> 'tenant_private'
     OR v_source_tenant <> NEW.tenant_id
     OR v_source_status <> 'active' THEN
    RAISE EXCEPTION 'Merge source must be an active tenant-private entity in this tenant'
      USING ERRCODE = '23514';
  END IF;

  IF v_target_status <> 'active'
     OR (
       v_target_scope <> 'global_public'
       AND NOT (
         v_target_scope = 'tenant_private'
         AND v_target_tenant = NEW.tenant_id
       )
     ) THEN
    RAISE EXCEPTION 'Merge target must be an active entity visible to this tenant'
      USING ERRCODE = '23514';
  END IF;

  IF v_source_type <> v_target_type THEN
    RAISE EXCEPTION 'Canonical entity merge requires matching entity types'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "canonical_entity_merges_enforce_scope"
  BEFORE INSERT ON "canonical_entity_merges"
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_entity_merge_record();

CREATE OR REPLACE FUNCTION require_canonical_entity_merge_lineage()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'merged' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM canonical_entity_merges
      WHERE tenant_id = OLD.tenant_id
        AND source_entity_id = OLD.id
        AND target_entity_id = NEW.merged_into_entity_id
    ) THEN
      RAISE EXCEPTION 'Canonical entity merge requires append-only merge lineage'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "canonical_entities_require_merge_lineage"
  BEFORE UPDATE OF "status", "merged_into_entity_id"
  ON "canonical_entities"
  FOR EACH ROW EXECUTE FUNCTION require_canonical_entity_merge_lineage();

CREATE OR REPLACE FUNCTION reject_canonical_entity_merge_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'CanonicalEntityMerge is append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE'
     AND NOT (rls_bypass() AND current_setting('app.knowledge_purge', true) = 'on') THEN
    RAISE EXCEPTION 'CanonicalEntityMerge deletion requires the explicit legal purge path'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "canonical_entity_merges_reject_mutation"
  BEFORE UPDATE OR DELETE ON "canonical_entity_merges"
  FOR EACH ROW EXECUTE FUNCTION reject_canonical_entity_merge_mutation();

ALTER TABLE "canonical_entity_merges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_entity_merges" FORCE ROW LEVEL SECURITY;

CREATE POLICY "canonical_entity_merges_select_policy"
  ON "canonical_entity_merges"
  FOR SELECT
  USING (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "canonical_entity_merges_insert_policy"
  ON "canonical_entity_merges"
  FOR INSERT
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "canonical_entity_merges_update_policy"
  ON "canonical_entity_merges"
  FOR UPDATE
  USING (false)
  WITH CHECK (false);
CREATE POLICY "canonical_entity_merges_delete_policy"
  ON "canonical_entity_merges"
  FOR DELETE
  USING (rls_bypass() AND current_setting('app.knowledge_purge', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT ON TABLE "canonical_entity_merges" TO capiro_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "canonical_entity_merges" FROM capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "canonical_entity_merges" IS
  'Append-only Phase 5 lineage for deterministic/human-approved canonical identity convergence.';
