-- Global, immutable evidence edges from source identities to canonical programs.
-- A source identity can fan out to many programs (split/related mappings); each
-- identity+program+relationship edge has a linear append-only revision chain.
CREATE TABLE "program_identity_crosswalk" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" UUID NOT NULL,
    "identity_kind" VARCHAR(32) NOT NULL,
    "source_system" VARCHAR(64) NOT NULL,
    "source_identifier" VARCHAR(256) NOT NULL,
    "relationship_kind" VARCHAR(24) NOT NULL,
    "valid_from_fy" INTEGER,
    "valid_to_fy" INTEGER,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_id" UUID,
    "source" VARCHAR(128) NOT NULL,
    "source_url" TEXT,
    "source_document_id" UUID,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "program_identity_crosswalk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "program_identity_crosswalk_program_fkey"
      FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "program_identity_crosswalk_source_document_fkey"
      FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "program_identity_crosswalk_supersedes_fkey"
      FOREIGN KEY ("supersedes_id") REFERENCES "program_identity_crosswalk"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "program_identity_crosswalk_kind_check"
      CHECK ("identity_kind" IN ('pe','pe_project','procurement_line','mdap','source_program')),
    CONSTRAINT "program_identity_crosswalk_relationship_check"
      CHECK ("relationship_kind" IN ('same_as','predecessor','successor','split_from','merged_into','related_to')),
    CONSTRAINT "program_identity_crosswalk_review_check"
      CHECK ("review_status" IN ('candidate','accepted','rejected','quarantined')),
    CONSTRAINT "program_identity_crosswalk_fy_check"
      CHECK ("valid_from_fy" IS NULL OR "valid_to_fy" IS NULL OR "valid_to_fy" >= "valid_from_fy"),
    CONSTRAINT "program_identity_crosswalk_confidence_check"
      CHECK ("confidence" >= 0 AND "confidence" <= 1),
    CONSTRAINT "program_identity_crosswalk_recorded_review_check"
      CHECK (("review_status" = 'accepted' AND "reviewed_at" IS NOT NULL) OR "review_status" <> 'accepted')
);

CREATE INDEX "program_identity_crosswalk_identity_time_idx"
  ON "program_identity_crosswalk" ("identity_kind", "source_system", "source_identifier", "recorded_at" DESC, "id");
CREATE INDEX "program_identity_crosswalk_program_fy_idx"
  ON "program_identity_crosswalk" ("program_id", "valid_from_fy", "valid_to_fy");
CREATE INDEX "program_identity_crosswalk_source_document_idx"
  ON "program_identity_crosswalk" ("source_document_id");
CREATE INDEX "program_identity_crosswalk_review_idx"
  ON "program_identity_crosswalk" ("review_status", "recorded_at" DESC);

-- One first revision per logical edge; descendants must point to that edge's
-- prior head. The partial root uniqueness plus unique successor prevents parallel
-- current chains while still allowing the same source identity to fan out.
CREATE UNIQUE INDEX "program_identity_crosswalk_edge_root_key"
  ON "program_identity_crosswalk" ("identity_kind", "source_system", "source_identifier", "program_id", "relationship_kind")
  WHERE "supersedes_id" IS NULL;
CREATE UNIQUE INDEX "program_identity_crosswalk_supersedes_key"
  ON "program_identity_crosswalk" ("supersedes_id") WHERE "supersedes_id" IS NOT NULL;

CREATE FUNCTION prevent_program_identity_crosswalk_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'program_identity_crosswalk is append-only; insert a superseding revision';
END;
$$;
CREATE TRIGGER "program_identity_crosswalk_immutable"
  BEFORE UPDATE OR DELETE ON "program_identity_crosswalk"
  FOR EACH ROW EXECUTE FUNCTION prevent_program_identity_crosswalk_mutation();

CREATE FUNCTION validate_program_identity_crosswalk_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prior "program_identity_crosswalk"%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO prior FROM "program_identity_crosswalk" WHERE id = NEW.supersedes_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supersedes_id must reference an existing crosswalk revision';
  END IF;
  IF (NEW.identity_kind, NEW.source_system, NEW.source_identifier, NEW.program_id, NEW.relationship_kind)
     IS DISTINCT FROM
     (prior.identity_kind, prior.source_system, prior.source_identifier, prior.program_id, prior.relationship_kind) THEN
    RAISE EXCEPTION 'a revision must retain its logical identity edge';
  END IF;
  IF NEW.recorded_at <= prior.recorded_at THEN
    RAISE EXCEPTION 'recorded_at must increase across revisions';
  END IF;
  IF EXISTS (SELECT 1 FROM "program_identity_crosswalk" child WHERE child.supersedes_id = prior.id) THEN
    RAISE EXCEPTION 'revision predecessor already has a successor';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "program_identity_crosswalk_revision_valid"
  BEFORE INSERT ON "program_identity_crosswalk"
  FOR EACH ROW EXECUTE FUNCTION validate_program_identity_crosswalk_revision();

GRANT SELECT, INSERT ON "program_identity_crosswalk" TO capiro_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "program_identity_crosswalk" FROM capiro_app;
