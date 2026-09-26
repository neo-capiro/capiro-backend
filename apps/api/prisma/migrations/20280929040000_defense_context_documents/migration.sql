-- Defense Research Phase 4: qualified contextual documents, immutable source
-- revisions/sections, exact reference occurrences, and honest coverage states.

CREATE TABLE "defense_context_documents" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "source_key" VARCHAR(256) NOT NULL,
  "family" VARCHAR(64) NOT NULL,
  "publisher" VARCHAR(200) NOT NULL,
  "publisher_host" VARCHAR(255),
  "title" TEXT NOT NULL,
  "congress" INTEGER,
  "committee" VARCHAR(300),
  "publication_period_start" DATE,
  "publication_period_end" DATE,
  "published_at" TIMESTAMPTZ(6),
  "status" VARCHAR(48) NOT NULL,
  "transcript_availability" VARCHAR(32) NOT NULL,
  "coverage" VARCHAR(24) NOT NULL,
  "coverage_reason" TEXT,
  "qualification" VARCHAR(32) NOT NULL,
  "source_url" TEXT,
  "eligible" BOOLEAN NOT NULL DEFAULT true,
  "current_revision_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_context_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defense_context_documents_coverage_check" CHECK ("coverage" IN ('available','partial','unavailable')),
  CONSTRAINT "defense_context_documents_transcript_check" CHECK ("transcript_availability" IN ('available','partial','unavailable','not_applicable'))
);
CREATE UNIQUE INDEX "defense_context_documents_source_key_key" ON "defense_context_documents"("source_key");
CREATE UNIQUE INDEX "defense_context_documents_current_revision_key" ON "defense_context_documents"("current_revision_id");
CREATE INDEX "defense_context_documents_family_publisher_idx" ON "defense_context_documents"("family", "publisher", "published_at" DESC);
CREATE INDEX "defense_context_documents_coverage_idx" ON "defense_context_documents"("coverage", "qualification", "eligible");

CREATE TABLE "defense_context_document_revisions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "document_id" UUID NOT NULL,
  "source_document_id" UUID,
  "version" VARCHAR(128) NOT NULL,
  "content_hash" CHAR(64),
  "published_at" TIMESTAMPTZ(6),
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "status" VARCHAR(48) NOT NULL,
  "source_url" TEXT,
  "provenance" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "defense_context_document_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "defense_context_document_revisions_version_hash_key" ON "defense_context_document_revisions"("document_id", "version", "content_hash");
CREATE INDEX "defense_context_document_revisions_observed_idx" ON "defense_context_document_revisions"("document_id", "observed_at" DESC);
CREATE INDEX "defense_context_document_revisions_source_document_idx" ON "defense_context_document_revisions"("source_document_id");

CREATE TABLE "defense_context_sections" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "revision_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "native_locator" VARCHAR(300),
  "text_availability" VARCHAR(24) NOT NULL,
  "content_hash" CHAR(64),
  "content_text" TEXT,
  CONSTRAINT "defense_context_sections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defense_context_sections_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "defense_context_sections_availability_check" CHECK ("text_availability" IN ('available','partial','unavailable'))
);
CREATE UNIQUE INDEX "defense_context_sections_revision_ordinal_key" ON "defense_context_sections"("revision_id", "ordinal");
CREATE INDEX "defense_context_sections_locator_idx" ON "defense_context_sections"("revision_id", "native_locator");

CREATE TABLE "defense_reference_occurrences" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "document_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "section_id" UUID,
  "exact_span" TEXT NOT NULL,
  "start_offset" INTEGER,
  "end_offset" INTEGER,
  "original_wording" TEXT NOT NULL,
  "reference_type" VARCHAR(64) NOT NULL,
  "target_candidates" JSONB NOT NULL DEFAULT '[]',
  "resolved_target" JSONB,
  "resolved_target_document_id" UUID,
  "resolved_target_revision_id" UUID,
  "resolved_target_section_id" UUID,
  "disposition" VARCHAR(24) NOT NULL,
  "target_availability" VARCHAR(24) NOT NULL,
  "reviewed_by_user_id" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_reference_occurrences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defense_reference_occurrences_offsets_check" CHECK (("start_offset" IS NULL AND "end_offset" IS NULL) OR ("start_offset" >= 0 AND "end_offset" > "start_offset")),
  CONSTRAINT "defense_reference_occurrences_disposition_check" CHECK ("disposition" IN ('resolved','ambiguous','unresolved','unavailable')),
  CONSTRAINT "defense_reference_occurrences_target_availability_check" CHECK ("target_availability" IN ('available','partial','unavailable'))
);
CREATE INDEX "defense_reference_occurrences_source_idx" ON "defense_reference_occurrences"("document_id", "revision_id", "section_id");
CREATE INDEX "defense_reference_occurrences_target_idx" ON "defense_reference_occurrences"("resolved_target_document_id", "disposition");
CREATE INDEX "defense_reference_occurrences_type_idx" ON "defense_reference_occurrences"("reference_type", "disposition");

ALTER TABLE "defense_context_document_revisions"
  ADD CONSTRAINT "defense_context_document_revisions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "defense_context_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_context_document_revisions_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "defense_context_sections"
  ADD CONSTRAINT "defense_context_sections_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "defense_context_document_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "defense_reference_occurrences"
  ADD CONSTRAINT "defense_reference_occurrences_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "defense_context_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_reference_occurrences_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "defense_context_document_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_reference_occurrences_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "defense_context_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_reference_occurrences_resolved_document_id_fkey" FOREIGN KEY ("resolved_target_document_id") REFERENCES "defense_context_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_reference_occurrences_resolved_revision_id_fkey" FOREIGN KEY ("resolved_target_revision_id") REFERENCES "defense_context_document_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_reference_occurrences_resolved_section_id_fkey" FOREIGN KEY ("resolved_target_section_id") REFERENCES "defense_context_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "defense_context_documents"
  ADD CONSTRAINT "defense_context_documents_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "defense_context_document_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION defense_context_evidence_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'defense contextual evidence history is append-only';
END;
$$;
CREATE TRIGGER "defense_context_document_revisions_append_only_trigger"
BEFORE UPDATE OR DELETE ON "defense_context_document_revisions"
FOR EACH ROW EXECUTE FUNCTION defense_context_evidence_append_only();
CREATE TRIGGER "defense_context_sections_append_only_trigger"
BEFORE UPDATE OR DELETE ON "defense_context_sections"
FOR EACH ROW EXECUTE FUNCTION defense_context_evidence_append_only();
CREATE TRIGGER "defense_reference_occurrences_append_only_trigger"
BEFORE UPDATE OR DELETE ON "defense_reference_occurrences"
FOR EACH ROW EXECUTE FUNCTION defense_context_evidence_append_only();
