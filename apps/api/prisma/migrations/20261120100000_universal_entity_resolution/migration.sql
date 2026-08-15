-- Knowledge Plane — Phase 5: Universal Entity Resolution.
--
-- This is the single canonical identity registry shared by every Capiro
-- surface. It does not replace CRM, Directory, government datasets, the
-- KnowledgeEvent ledger, or the Temporal Knowledge Graph. Public identity may
-- be reusable globally; private aliases, identifiers, and resolution history
-- remain tenant scoped.
--
-- The runtime application role can bypass RLS in this deployment, so every
-- repository statement MUST also include explicit visibility/tenant predicates.

CREATE TABLE "canonical_entities" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID,
  "identity_scope" VARCHAR(24) NOT NULL,
  "entity_type" VARCHAR(64) NOT NULL,
  "canonical_name" TEXT NOT NULL,
  "normalized_name" TEXT NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "resolution_confidence" NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  "resolution_method" VARCHAR(64) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "merged_into_entity_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "canonical_entities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_entities_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "canonical_entities_merged_into_fkey"
    FOREIGN KEY ("merged_into_entity_id") REFERENCES "canonical_entities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "canonical_entities_scope_check"
    CHECK (
      ("identity_scope" = 'global_public' AND "tenant_id" IS NULL)
      OR
      ("identity_scope" = 'tenant_private' AND "tenant_id" IS NOT NULL)
    ),
  CONSTRAINT "canonical_entities_type_check"
    CHECK ("entity_type" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "canonical_entities_name_check"
    CHECK (
      length(btrim("canonical_name")) > 0
      AND length(btrim("normalized_name")) > 0
    ),
  CONSTRAINT "canonical_entities_status_check"
    CHECK ("status" IN ('active', 'merged', 'withdrawn')),
  CONSTRAINT "canonical_entities_merge_state_check"
    CHECK (
      ("status" = 'merged' AND "merged_into_entity_id" IS NOT NULL)
      OR
      ("status" <> 'merged' AND "merged_into_entity_id" IS NULL)
    ),
  CONSTRAINT "canonical_entities_not_self_merged_check"
    CHECK ("merged_into_entity_id" IS NULL OR "merged_into_entity_id" <> "id"),
  CONSTRAINT "canonical_entities_confidence_check"
    CHECK ("resolution_confidence" >= 0 AND "resolution_confidence" <= 1),
  CONSTRAINT "canonical_entities_method_check"
    CHECK ("resolution_method" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "canonical_entities_metadata_check"
    CHECK (jsonb_typeof("metadata") = 'object')
);

CREATE INDEX "canonical_entities_visible_name_idx"
  ON "canonical_entities" (
    "entity_type",
    "normalized_name",
    "identity_scope",
    "tenant_id",
    "status"
  );
CREATE INDEX "canonical_entities_tenant_created_idx"
  ON "canonical_entities" ("tenant_id", "created_at" DESC)
  WHERE "tenant_id" IS NOT NULL;
CREATE INDEX "canonical_entities_merged_into_idx"
  ON "canonical_entities" ("merged_into_entity_id")
  WHERE "merged_into_entity_id" IS NOT NULL;

CREATE TABLE "entity_aliases" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "entity_id" UUID NOT NULL,
  "tenant_id" UUID,
  "identity_scope" VARCHAR(24) NOT NULL,
  "alias" TEXT NOT NULL,
  "normalized_alias" TEXT NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" VARCHAR(512),
  "confidence" NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  "verified_at" TIMESTAMPTZ(6),
  "status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "entity_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "entity_aliases_entity_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "canonical_entities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "entity_aliases_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "entity_aliases_scope_check"
    CHECK (
      ("identity_scope" = 'global_public' AND "tenant_id" IS NULL)
      OR
      ("identity_scope" = 'tenant_private' AND "tenant_id" IS NOT NULL)
    ),
  CONSTRAINT "entity_aliases_value_check"
    CHECK (
      length(btrim("alias")) > 0
      AND length(btrim("normalized_alias")) > 0
    ),
  CONSTRAINT "entity_aliases_source_type_check"
    CHECK ("source_type" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "entity_aliases_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "entity_aliases_status_check"
    CHECK ("status" IN ('active', 'withdrawn'))
);

CREATE UNIQUE INDEX "entity_aliases_global_entity_value_unique"
  ON "entity_aliases" ("entity_id", "normalized_alias", "source_type")
  WHERE "tenant_id" IS NULL AND "status" = 'active';
CREATE UNIQUE INDEX "entity_aliases_tenant_entity_value_unique"
  ON "entity_aliases" ("tenant_id", "entity_id", "normalized_alias", "source_type")
  WHERE "tenant_id" IS NOT NULL AND "status" = 'active';
CREATE INDEX "entity_aliases_global_lookup_idx"
  ON "entity_aliases" ("normalized_alias", "entity_id")
  WHERE "identity_scope" = 'global_public' AND "status" = 'active';
CREATE INDEX "entity_aliases_tenant_lookup_idx"
  ON "entity_aliases" ("tenant_id", "normalized_alias", "entity_id")
  WHERE "identity_scope" = 'tenant_private' AND "status" = 'active';

CREATE TABLE "entity_identifiers" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "entity_id" UUID NOT NULL,
  "tenant_id" UUID,
  "identity_scope" VARCHAR(24) NOT NULL,
  "identifier_type" VARCHAR(64) NOT NULL,
  "identifier_value" TEXT NOT NULL,
  "normalized_value" TEXT NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" VARCHAR(512),
  "confidence" NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  "verified_at" TIMESTAMPTZ(6),
  "status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "entity_identifiers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "entity_identifiers_entity_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "canonical_entities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "entity_identifiers_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "entity_identifiers_scope_check"
    CHECK (
      ("identity_scope" = 'global_public' AND "tenant_id" IS NULL)
      OR
      ("identity_scope" = 'tenant_private' AND "tenant_id" IS NOT NULL)
    ),
  CONSTRAINT "entity_identifiers_type_check"
    CHECK ("identifier_type" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "entity_identifiers_value_check"
    CHECK (
      length(btrim("identifier_value")) > 0
      AND length(btrim("normalized_value")) > 0
    ),
  CONSTRAINT "entity_identifiers_source_type_check"
    CHECK ("source_type" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "entity_identifiers_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "entity_identifiers_status_check"
    CHECK ("status" IN ('active', 'withdrawn'))
);

CREATE UNIQUE INDEX "entity_identifiers_global_identity_unique"
  ON "entity_identifiers" ("identifier_type", "normalized_value")
  WHERE "identity_scope" = 'global_public' AND "status" = 'active';
CREATE UNIQUE INDEX "entity_identifiers_tenant_identity_unique"
  ON "entity_identifiers" ("tenant_id", "identifier_type", "normalized_value")
  WHERE "identity_scope" = 'tenant_private' AND "status" = 'active';
CREATE INDEX "entity_identifiers_entity_idx"
  ON "entity_identifiers" ("entity_id", "identifier_type", "status");

CREATE TABLE "entity_resolutions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(64) NOT NULL,
  "actor_user_id" UUID,
  "raw_input" TEXT NOT NULL,
  "normalized_input" TEXT NOT NULL,
  "entity_type_hint" VARCHAR(64),
  "candidate_entity_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "selected_entity_id" UUID,
  "status" VARCHAR(24) NOT NULL,
  "confidence" NUMERIC(5,4) NOT NULL,
  "resolution_method" VARCHAR(64) NOT NULL,
  "provenance" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "correction_of_resolution_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "entity_resolutions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "entity_resolutions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "entity_resolutions_selected_entity_fkey"
    FOREIGN KEY ("selected_entity_id") REFERENCES "canonical_entities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "entity_resolutions_correction_fkey"
    FOREIGN KEY ("correction_of_resolution_id") REFERENCES "entity_resolutions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "entity_resolutions_identity_unique"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "entity_resolutions_idempotency_check"
    CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "entity_resolutions_input_check"
    CHECK (
      length(btrim("raw_input")) > 0
      AND length(btrim("normalized_input")) > 0
    ),
  CONSTRAINT "entity_resolutions_type_hint_check"
    CHECK (
      "entity_type_hint" IS NULL
      OR "entity_type_hint" ~ '^[a-z][a-z0-9_]{0,63}$'
    ),
  CONSTRAINT "entity_resolutions_candidates_check"
    CHECK (jsonb_typeof("candidate_entity_ids") = 'array'),
  CONSTRAINT "entity_resolutions_status_check"
    CHECK ("status" IN ('resolved', 'ambiguous', 'unresolved', 'rejected', 'corrected')),
  CONSTRAINT "entity_resolutions_selected_state_check"
    CHECK (
      ("status" IN ('resolved', 'corrected') AND "selected_entity_id" IS NOT NULL)
      OR
      ("status" NOT IN ('resolved', 'corrected') AND "selected_entity_id" IS NULL)
    ),
  CONSTRAINT "entity_resolutions_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "entity_resolutions_method_check"
    CHECK ("resolution_method" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "entity_resolutions_provenance_check"
    CHECK (jsonb_typeof("provenance") = 'array')
);

CREATE INDEX "entity_resolutions_tenant_created_idx"
  ON "entity_resolutions" ("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "entity_resolutions_selected_entity_idx"
  ON "entity_resolutions" ("tenant_id", "selected_entity_id", "created_at" DESC)
  WHERE "selected_entity_id" IS NOT NULL;
CREATE INDEX "entity_resolutions_correction_idx"
  ON "entity_resolutions" ("tenant_id", "correction_of_resolution_id")
  WHERE "correction_of_resolution_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_canonical_identity_link_scope()
RETURNS trigger AS $$
DECLARE
  v_entity_scope TEXT;
  v_entity_tenant UUID;
  v_entity_status TEXT;
BEGIN
  SELECT identity_scope, tenant_id, status
    INTO v_entity_scope, v_entity_tenant, v_entity_status
  FROM canonical_entities
  WHERE id = NEW.entity_id;

  IF v_entity_scope IS NULL OR v_entity_status <> 'active' THEN
    RAISE EXCEPTION 'Canonical identity link requires an active entity'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.identity_scope = 'global_public' THEN
    IF NEW.tenant_id IS NOT NULL OR v_entity_scope <> 'global_public' THEN
      RAISE EXCEPTION 'Global identity links may target only global public entities'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS NULL THEN
      RAISE EXCEPTION 'Tenant-private identity links require tenant_id'
        USING ERRCODE = '23514';
    END IF;
    IF v_entity_scope = 'tenant_private' AND v_entity_tenant <> NEW.tenant_id THEN
      RAISE EXCEPTION 'Tenant-private identity links cannot cross tenants'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entity_aliases_enforce_scope"
  BEFORE INSERT OR UPDATE OF "entity_id", "tenant_id", "identity_scope"
  ON "entity_aliases"
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_identity_link_scope();

CREATE TRIGGER "entity_identifiers_enforce_scope"
  BEFORE INSERT OR UPDATE OF "entity_id", "tenant_id", "identity_scope"
  ON "entity_identifiers"
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_identity_link_scope();

CREATE OR REPLACE FUNCTION enforce_entity_resolution_scope()
RETURNS trigger AS $$
DECLARE
  v_entity_scope TEXT;
  v_entity_tenant UUID;
  v_correction_tenant UUID;
BEGIN
  IF NEW.selected_entity_id IS NOT NULL THEN
    SELECT identity_scope, tenant_id
      INTO v_entity_scope, v_entity_tenant
    FROM canonical_entities
    WHERE id = NEW.selected_entity_id
      AND status = 'active';

    IF v_entity_scope IS NULL
       OR (v_entity_scope = 'tenant_private' AND v_entity_tenant <> NEW.tenant_id) THEN
      RAISE EXCEPTION 'Selected canonical entity is not visible to this tenant'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.correction_of_resolution_id IS NOT NULL THEN
    SELECT tenant_id INTO v_correction_tenant
    FROM entity_resolutions
    WHERE id = NEW.correction_of_resolution_id;

    IF v_correction_tenant IS NULL OR v_correction_tenant <> NEW.tenant_id THEN
      RAISE EXCEPTION 'Corrected resolution must exist in the same tenant'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entity_resolutions_enforce_scope"
  BEFORE INSERT ON "entity_resolutions"
  FOR EACH ROW EXECUTE FUNCTION enforce_entity_resolution_scope();

CREATE OR REPLACE FUNCTION touch_canonical_entity_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "canonical_entities_touch_updated_at"
  BEFORE UPDATE ON "canonical_entities"
  FOR EACH ROW EXECUTE FUNCTION touch_canonical_entity_updated_at();

CREATE OR REPLACE FUNCTION reject_entity_resolution_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EntityResolution is append-only; record a correction instead'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entity_resolutions_reject_update"
  BEFORE UPDATE ON "entity_resolutions"
  FOR EACH ROW EXECUTE FUNCTION reject_entity_resolution_mutation();
CREATE TRIGGER "entity_resolutions_reject_delete"
  BEFORE DELETE ON "entity_resolutions"
  FOR EACH ROW EXECUTE FUNCTION reject_entity_resolution_mutation();

ALTER TABLE "canonical_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_entities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "canonical_entities_visible_read" ON "canonical_entities"
  FOR SELECT
  USING (
    rls_bypass()
    OR "identity_scope" = 'global_public'
    OR "tenant_id" = current_tenant_id()
  );
CREATE POLICY "canonical_entities_tenant_insert" ON "canonical_entities"
  FOR INSERT
  WITH CHECK (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  );
CREATE POLICY "canonical_entities_tenant_update" ON "canonical_entities"
  FOR UPDATE
  USING (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  )
  WITH CHECK (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  );

ALTER TABLE "entity_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entity_aliases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "entity_aliases_visible_read" ON "entity_aliases"
  FOR SELECT
  USING (
    rls_bypass()
    OR "identity_scope" = 'global_public'
    OR "tenant_id" = current_tenant_id()
  );
CREATE POLICY "entity_aliases_tenant_insert" ON "entity_aliases"
  FOR INSERT
  WITH CHECK (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  );
CREATE POLICY "entity_aliases_tenant_update" ON "entity_aliases"
  FOR UPDATE
  USING (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  )
  WITH CHECK (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  );

ALTER TABLE "entity_identifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entity_identifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "entity_identifiers_visible_read" ON "entity_identifiers"
  FOR SELECT
  USING (
    rls_bypass()
    OR "identity_scope" = 'global_public'
    OR "tenant_id" = current_tenant_id()
  );
CREATE POLICY "entity_identifiers_tenant_insert" ON "entity_identifiers"
  FOR INSERT
  WITH CHECK (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  );
CREATE POLICY "entity_identifiers_tenant_update" ON "entity_identifiers"
  FOR UPDATE
  USING (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  )
  WITH CHECK (
    rls_bypass()
    OR (
      "identity_scope" = 'tenant_private'
      AND "tenant_id" = current_tenant_id()
    )
  );

ALTER TABLE "entity_resolutions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entity_resolutions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "entity_resolutions_tenant_isolation" ON "entity_resolutions"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

REVOKE DELETE, TRUNCATE ON TABLE "canonical_entities" FROM capiro_app;
REVOKE DELETE, TRUNCATE ON TABLE "entity_aliases" FROM capiro_app;
REVOKE DELETE, TRUNCATE ON TABLE "entity_identifiers" FROM capiro_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "entity_resolutions" FROM capiro_app;

GRANT SELECT, INSERT, UPDATE ON TABLE "canonical_entities" TO capiro_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "entity_aliases" TO capiro_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "entity_identifiers" TO capiro_app;
GRANT SELECT, INSERT ON TABLE "entity_resolutions" TO capiro_app;

COMMENT ON TABLE "canonical_entities" IS
  'Universal entity registry. Public identity may be global; private identity remains tenant scoped.';
COMMENT ON TABLE "entity_aliases" IS
  'Scoped aliases for canonical entities. Private aliases never become globally visible.';
COMMENT ON TABLE "entity_identifiers" IS
  'Namespaced deterministic identifiers such as email, domain, UEI, CAGE, CIK, Directory IDs, and CRM IDs.';
COMMENT ON TABLE "entity_resolutions" IS
  'Append-only tenant-scoped resolution decisions, ambiguity, provenance, and user corrections.';
