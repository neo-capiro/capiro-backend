-- Institutional Memory Context Plane — Phase 3.
--
-- knowledge_evidence is the immutable excerpt-level proof beneath each atomic
-- knowledge_assertion. The canonical source body remains in its owning source
-- system; this ledger stores only the exact excerpt, offsets, source identity,
-- and the KnowledgeEvent content hash that binds the excerpt to one source
-- version. Existing governed memory_items remain the curated projection layer.

CREATE TABLE "knowledge_evidence" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "assertion_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,

  "source_type" VARCHAR(96) NOT NULL,
  "source_id" VARCHAR(512) NOT NULL,
  "excerpt" TEXT NOT NULL,
  "start_offset" INTEGER NOT NULL,
  "end_offset" INTEGER NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_evidence_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_evidence_assertion_fkey"
    FOREIGN KEY ("assertion_id") REFERENCES "knowledge_assertions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_evidence_event_fkey"
    FOREIGN KEY ("event_id") REFERENCES "knowledge_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "knowledge_evidence_identity_unique"
    UNIQUE (
      "tenant_id",
      "assertion_id",
      "event_id",
      "content_hash",
      "start_offset",
      "end_offset"
    ),
  CONSTRAINT "knowledge_evidence_source_type_check"
    CHECK ("source_type" ~ '^[a-z][a-z0-9_]{0,95}$'),
  CONSTRAINT "knowledge_evidence_source_id_check"
    CHECK (length(btrim("source_id")) > 0),
  CONSTRAINT "knowledge_evidence_excerpt_check"
    CHECK (length(btrim("excerpt")) > 0 AND char_length("excerpt") <= 16000),
  CONSTRAINT "knowledge_evidence_offsets_check"
    CHECK (
      "start_offset" >= 0
      AND "end_offset" > "start_offset"
      AND ("end_offset" - "start_offset") <= 16000
    ),
  CONSTRAINT "knowledge_evidence_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "knowledge_evidence_source_not_model_answer_check"
    CHECK ("source_type" NOT IN (
      'assistant_answer',
      'llm_output',
      'meri_answer',
      'model_answer',
      'model_output'
    ))
);

CREATE INDEX "knowledge_evidence_assertion_idx"
  ON "knowledge_evidence" ("tenant_id", "assertion_id", "created_at", "id");
CREATE INDEX "knowledge_evidence_event_idx"
  ON "knowledge_evidence" ("tenant_id", "event_id", "created_at", "id");
CREATE INDEX "knowledge_evidence_source_idx"
  ON "knowledge_evidence" ("tenant_id", "source_type", "source_id");

-- A simple Prisma relation represents each foreign key. This trigger adds the
-- stronger same-tenant, active-source, exact-source-identity, source-version,
-- sensitivity, and access-scope invariants at the database boundary.
CREATE OR REPLACE FUNCTION enforce_knowledge_evidence_links()
RETURNS trigger AS $$
DECLARE
  v_assertion_tenant UUID;
  v_assertion_sensitivity TEXT;
  v_assertion_access_scope JSONB;
  v_event_tenant UUID;
  v_event_status TEXT;
  v_event_source_type TEXT;
  v_event_source_id TEXT;
  v_event_content_hash TEXT;
  v_event_sensitivity TEXT;
  v_event_access_scope JSONB;
BEGIN
  SELECT tenant_id, sensitivity, access_scope
    INTO v_assertion_tenant, v_assertion_sensitivity, v_assertion_access_scope
  FROM knowledge_assertions
  WHERE id = NEW.assertion_id;

  IF v_assertion_tenant IS NULL OR v_assertion_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'KnowledgeEvidence assertion must exist in the same tenant'
      USING ERRCODE = '23503';
  END IF;

  SELECT
    tenant_id,
    status,
    source_type,
    source_id,
    source_content_hash,
    sensitivity,
    access_scope
  INTO
    v_event_tenant,
    v_event_status,
    v_event_source_type,
    v_event_source_id,
    v_event_content_hash,
    v_event_sensitivity,
    v_event_access_scope
  FROM knowledge_events
  WHERE id = NEW.event_id;

  IF v_event_tenant IS NULL OR v_event_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'KnowledgeEvidence event must exist in the same tenant'
      USING ERRCODE = '23503';
  END IF;
  IF v_event_status <> 'active' THEN
    RAISE EXCEPTION 'KnowledgeEvidence requires an active KnowledgeEvent'
      USING ERRCODE = '23514';
  END IF;
  IF v_event_source_type IS DISTINCT FROM NEW.source_type
     OR v_event_source_id IS DISTINCT FROM NEW.source_id THEN
    RAISE EXCEPTION 'KnowledgeEvidence source identity must match its KnowledgeEvent'
      USING ERRCODE = '23514';
  END IF;
  IF v_event_content_hash IS DISTINCT FROM NEW.content_hash THEN
    RAISE EXCEPTION 'KnowledgeEvidence content hash must match its KnowledgeEvent source version'
      USING ERRCODE = '23514';
  END IF;
  IF v_event_sensitivity IS DISTINCT FROM v_assertion_sensitivity
     OR v_event_access_scope IS DISTINCT FROM v_assertion_access_scope THEN
    RAISE EXCEPTION 'KnowledgeEvidence cannot widen assertion sensitivity or access scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_evidence_enforce_links"
  BEFORE INSERT ON "knowledge_evidence"
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_evidence_links();

-- A new durable assertion must have at least one evidence row before its
-- transaction commits. DEFERRABLE is load-bearing: the assertion is inserted
-- first so its evidence foreign keys can point to it, then evidence is inserted
-- in the same transaction, and this check runs at commit.
CREATE OR REPLACE FUNCTION require_knowledge_assertion_evidence()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM knowledge_evidence
    WHERE tenant_id = NEW.tenant_id
      AND assertion_id = NEW.id
      AND event_id = NEW.origin_event_id
  ) THEN
    RAISE EXCEPTION 'KnowledgeAssertion requires at least one immutable KnowledgeEvidence row from its origin event'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "knowledge_assertions_require_evidence"
  AFTER INSERT ON "knowledge_assertions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_knowledge_assertion_evidence();

ALTER TABLE "knowledge_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_evidence_tenant_isolation" ON "knowledge_evidence"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

-- The API can append and read, never mutate. Trusted legal-deletion tooling must
-- use the same explicit bypass + app.allow_knowledge_purge contract established
-- by the Phase 1/2 migration.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "knowledge_evidence" FROM capiro_app;
GRANT SELECT, INSERT ON TABLE "knowledge_evidence" TO capiro_app;

CREATE TRIGGER "knowledge_evidence_reject_mutation"
  BEFORE UPDATE OR DELETE ON "knowledge_evidence"
  FOR EACH ROW EXECUTE FUNCTION reject_knowledge_plane_mutation();

COMMENT ON TABLE "knowledge_evidence" IS
  'Immutable tenant-scoped exact excerpts proving atomic KnowledgeAssertions.';
COMMENT ON COLUMN "knowledge_evidence"."start_offset" IS
  'Inclusive JavaScript string offset (UTF-16 code units) into canonical source text.';
COMMENT ON COLUMN "knowledge_evidence"."end_offset" IS
  'Exclusive JavaScript string offset (UTF-16 code units) into canonical source text.';
COMMENT ON COLUMN "knowledge_evidence"."content_hash" IS
  'SHA-256 of the entire canonical source text; must equal KnowledgeEvent.source_content_hash.';
