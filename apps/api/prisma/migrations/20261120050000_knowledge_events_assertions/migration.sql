-- Institutional Memory Context Plane — Phases 1 and 2.
--
-- knowledge_events are immutable source observations (evidence).
-- knowledge_assertions are immutable atomic interpretations of that evidence.
-- Existing governed memory_items remain the curated, human-readable projection.
--
-- The runtime application role can bypass PostgreSQL RLS in this deployment, so
-- application repositories also bind every statement to tenant_id. RLS remains
-- enabled and forced as defense in depth for all other database roles.

CREATE TABLE "knowledge_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(64) NOT NULL,

  "source_type" VARCHAR(96) NOT NULL,
  "source_id" VARCHAR(512) NOT NULL,
  "source_version" VARCHAR(160),
  "source_content_hash" VARCHAR(64) NOT NULL,
  "event_type" VARCHAR(96) NOT NULL,

  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "actor_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "entity_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "client_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,

  "sensitivity" VARCHAR(96) NOT NULL DEFAULT 'normal',
  "access_scope" JSONB NOT NULL DEFAULT '{"kind":"tenant"}'::jsonb,
  "evidence_locator" JSONB NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "origin_trace_id" VARCHAR(160),
  "status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_events_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_events_tenant_identity_unique"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "knowledge_events_idempotency_unique"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "knowledge_events_idempotency_sha256_check"
    CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "knowledge_events_source_hash_check"
    CHECK ("source_content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "knowledge_events_source_type_check"
    CHECK ("source_type" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_events_event_type_check"
    CHECK ("event_type" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_events_sensitivity_check"
    CHECK ("sensitivity" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_events_observation_order_check"
    CHECK ("observed_at" >= "occurred_at"),
  CONSTRAINT "knowledge_events_actor_refs_array_check"
    CHECK (jsonb_typeof("actor_refs") = 'array'),
  CONSTRAINT "knowledge_events_entity_refs_array_check"
    CHECK (jsonb_typeof("entity_refs") = 'array'),
  CONSTRAINT "knowledge_events_client_refs_array_check"
    CHECK (jsonb_typeof("client_refs") = 'array'),
  CONSTRAINT "knowledge_events_access_scope_object_check"
    CHECK (jsonb_typeof("access_scope") = 'object'),
  CONSTRAINT "knowledge_events_evidence_locator_check"
    CHECK (jsonb_typeof("evidence_locator") = 'object' AND "evidence_locator" <> '{}'::jsonb),
  CONSTRAINT "knowledge_events_metadata_object_check"
    CHECK (jsonb_typeof("metadata") = 'object'),
  CONSTRAINT "knowledge_events_status_check"
    CHECK ("status" IN ('active', 'withdrawn')),
  CONSTRAINT "knowledge_events_source_not_model_answer_check"
    CHECK ("source_type" NOT IN (
      'assistant_answer',
      'llm_output',
      'meri_answer',
      'model_answer',
      'model_output'
    ))
);

CREATE INDEX "knowledge_events_tenant_occurred_idx"
  ON "knowledge_events" ("tenant_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "knowledge_events_tenant_source_idx"
  ON "knowledge_events" ("tenant_id", "source_type", "source_id", "source_version");
CREATE INDEX "knowledge_events_tenant_type_observed_idx"
  ON "knowledge_events" ("tenant_id", "event_type", "observed_at" DESC);
CREATE INDEX "knowledge_events_origin_trace_idx"
  ON "knowledge_events" ("tenant_id", "origin_trace_id")
  WHERE "origin_trace_id" IS NOT NULL;
CREATE INDEX "knowledge_events_actor_refs_gin"
  ON "knowledge_events" USING GIN ("actor_refs");
CREATE INDEX "knowledge_events_entity_refs_gin"
  ON "knowledge_events" USING GIN ("entity_refs");
CREATE INDEX "knowledge_events_client_refs_gin"
  ON "knowledge_events" USING GIN ("client_refs");

CREATE TABLE "knowledge_assertions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(64) NOT NULL,
  "origin_event_id" UUID NOT NULL,

  "subject_type" VARCHAR(96) NOT NULL,
  "subject_id" VARCHAR(512) NOT NULL,
  "predicate" VARCHAR(96) NOT NULL,
  "object_type" VARCHAR(96) NOT NULL,
  "object_id" VARCHAR(512),
  "object_value" JSONB,

  "assertion_class" VARCHAR(32) NOT NULL,
  "confidence" NUMERIC(5,4) NOT NULL,
  "authority" VARCHAR(32) NOT NULL,

  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "valid_from" TIMESTAMPTZ(6) NOT NULL,
  "valid_until" TIMESTAMPTZ(6),

  "status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "conflict_status" VARCHAR(24) NOT NULL DEFAULT 'none',
  "conflict_group_id" UUID,
  "supersedes_assertion_id" UUID,
  "contradicts_assertion_id" UUID,

  "sensitivity" VARCHAR(96) NOT NULL DEFAULT 'normal',
  "access_scope" JSONB NOT NULL DEFAULT '{"kind":"tenant"}'::jsonb,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_assertions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_assertions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_assertions_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "knowledge_assertions_origin_event_fkey"
    FOREIGN KEY ("origin_event_id") REFERENCES "knowledge_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_assertions_tenant_identity_unique"
    UNIQUE ("tenant_id", "id"),
  CONSTRAINT "knowledge_assertions_idempotency_unique"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "knowledge_assertions_idempotency_sha256_check"
    CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "knowledge_assertions_subject_type_check"
    CHECK ("subject_type" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_assertions_predicate_check"
    CHECK ("predicate" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_assertions_object_type_check"
    CHECK ("object_type" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_assertions_object_required_check"
    CHECK (
      "object_id" IS NOT NULL
      OR ("object_value" IS NOT NULL AND "object_value" <> 'null'::jsonb)
    ),
  CONSTRAINT "knowledge_assertions_class_check"
    CHECK ("assertion_class" IN (
      'fact',
      'preference',
      'decision',
      'commitment',
      'position',
      'goal',
      'constraint',
      'relationship',
      'expertise',
      'influence',
      'risk',
      'strategy'
    )),
  CONSTRAINT "knowledge_assertions_confidence_check"
    CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "knowledge_assertions_authority_check"
    CHECK ("authority" IN (
      'model_inferred',
      'source_reported',
      'human_confirmed',
      'system_canonical'
    )),
  CONSTRAINT "knowledge_assertions_validity_check"
    CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
  CONSTRAINT "knowledge_assertions_status_check"
    CHECK ("status" IN ('active', 'withdrawn')),
  CONSTRAINT "knowledge_assertions_conflict_status_check"
    CHECK ("conflict_status" IN ('none', 'potential', 'confirmed', 'resolved')),
  CONSTRAINT "knowledge_assertions_conflict_group_check"
    CHECK (
      ("conflict_status" = 'none' AND "conflict_group_id" IS NULL)
      OR
      ("conflict_status" <> 'none' AND "conflict_group_id" IS NOT NULL)
    ),
  CONSTRAINT "knowledge_assertions_contradiction_status_check"
    CHECK ("contradicts_assertion_id" IS NULL OR "conflict_status" <> 'none'),
  CONSTRAINT "knowledge_assertions_not_self_superseding_check"
    CHECK ("supersedes_assertion_id" IS NULL OR "supersedes_assertion_id" <> "id"),
  CONSTRAINT "knowledge_assertions_not_self_contradicting_check"
    CHECK ("contradicts_assertion_id" IS NULL OR "contradicts_assertion_id" <> "id"),
  CONSTRAINT "knowledge_assertions_sensitivity_check"
    CHECK ("sensitivity" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_assertions_access_scope_object_check"
    CHECK (jsonb_typeof("access_scope") = 'object')
);

ALTER TABLE "knowledge_assertions"
  ADD CONSTRAINT "knowledge_assertions_supersedes_fkey"
  FOREIGN KEY ("supersedes_assertion_id")
  REFERENCES "knowledge_assertions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "knowledge_assertions"
  ADD CONSTRAINT "knowledge_assertions_contradicts_fkey"
  FOREIGN KEY ("contradicts_assertion_id")
  REFERENCES "knowledge_assertions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "knowledge_assertions_tenant_subject_idx"
  ON "knowledge_assertions" (
    "tenant_id",
    "subject_type",
    "subject_id",
    "predicate",
    "valid_from" DESC
  );
CREATE INDEX "knowledge_assertions_tenant_object_idx"
  ON "knowledge_assertions" ("tenant_id", "object_type", "object_id");
CREATE INDEX "knowledge_assertions_tenant_class_idx"
  ON "knowledge_assertions" ("tenant_id", "assertion_class", "observed_at" DESC);
CREATE INDEX "knowledge_assertions_origin_event_idx"
  ON "knowledge_assertions" ("tenant_id", "origin_event_id");
CREATE INDEX "knowledge_assertions_conflict_group_idx"
  ON "knowledge_assertions" ("tenant_id", "conflict_group_id");
CREATE INDEX "knowledge_assertions_temporal_idx"
  ON "knowledge_assertions" ("tenant_id", "valid_from" DESC, "valid_until");
CREATE INDEX "knowledge_assertions_object_value_gin"
  ON "knowledge_assertions" USING GIN ("object_value");

-- A simple Prisma relation can represent each foreign key without overlapping
-- tenant relation scalar fields. This trigger adds the stronger same-tenant,
-- active-evidence, and inherited-access invariants at the database boundary.
CREATE OR REPLACE FUNCTION enforce_knowledge_assertion_links()
RETURNS trigger AS $$
DECLARE
  v_event_tenant UUID;
  v_event_status TEXT;
  v_event_sensitivity TEXT;
  v_event_access_scope JSONB;
  v_linked_tenant UUID;
BEGIN
  SELECT tenant_id, status, sensitivity, access_scope
    INTO v_event_tenant, v_event_status, v_event_sensitivity, v_event_access_scope
  FROM knowledge_events
  WHERE id = NEW.origin_event_id;

  IF v_event_tenant IS NULL OR v_event_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'origin KnowledgeEvent must exist in the same tenant'
      USING ERRCODE = '23503';
  END IF;
  IF v_event_status <> 'active' THEN
    RAISE EXCEPTION 'origin KnowledgeEvent must be active'
      USING ERRCODE = '23514';
  END IF;
  IF v_event_sensitivity IS DISTINCT FROM NEW.sensitivity
     OR v_event_access_scope IS DISTINCT FROM NEW.access_scope THEN
    RAISE EXCEPTION 'KnowledgeAssertion must inherit evidence sensitivity and access scope'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.supersedes_assertion_id IS NOT NULL THEN
    SELECT tenant_id INTO v_linked_tenant
    FROM knowledge_assertions
    WHERE id = NEW.supersedes_assertion_id;
    IF v_linked_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'superseded KnowledgeAssertion must exist in the same tenant'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.contradicts_assertion_id IS NOT NULL THEN
    v_linked_tenant := NULL;
    SELECT tenant_id INTO v_linked_tenant
    FROM knowledge_assertions
    WHERE id = NEW.contradicts_assertion_id;
    IF v_linked_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'contradicted KnowledgeAssertion must exist in the same tenant'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_assertions_enforce_links"
  BEFORE INSERT ON "knowledge_assertions"
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_assertion_links();

-- Defense-in-depth tenant policies. Application raw SQL still includes tenant_id.
ALTER TABLE "knowledge_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_events_tenant_isolation" ON "knowledge_events"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

ALTER TABLE "knowledge_assertions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_assertions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_assertions_tenant_isolation" ON "knowledge_assertions"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

-- The API can append and read, never mutate. Trusted legal-deletion tooling must
-- use a migration/master role and explicitly enable both bypass and purge GUCs.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_events" FROM capiro_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_assertions" FROM capiro_app;
GRANT SELECT, INSERT ON TABLE "knowledge_events" TO capiro_app;
GRANT SELECT, INSERT ON TABLE "knowledge_assertions" TO capiro_app;

CREATE OR REPLACE FUNCTION reject_knowledge_plane_mutation()
RETURNS trigger AS $$
BEGIN
  IF rls_bypass()
     AND current_setting('app.allow_knowledge_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; create a new knowledge row instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_events_reject_mutation"
  BEFORE UPDATE OR DELETE ON "knowledge_events"
  FOR EACH ROW EXECUTE FUNCTION reject_knowledge_plane_mutation();

CREATE TRIGGER "knowledge_assertions_reject_mutation"
  BEFORE UPDATE OR DELETE ON "knowledge_assertions"
  FOR EACH ROW EXECUTE FUNCTION reject_knowledge_plane_mutation();

COMMENT ON TABLE "knowledge_events" IS
  'Immutable tenant-scoped source observations; evidence beneath governed memory_items.';
COMMENT ON TABLE "knowledge_assertions" IS
  'Immutable tenant-scoped atomic interpretations, each backed by a KnowledgeEvent.';
COMMENT ON COLUMN "knowledge_assertions"."origin_event_id" IS
  'Required minimum provenance. Phase 3 adds excerpt-level KnowledgeEvidence links.';
