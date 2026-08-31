-- Phase 10B-18 Part C — source-bundle member manifest.
--
-- Adds the missing volume/budget-activity discriminator layer on top of
-- `defense_budget_expected_source`, whose dedup key (fiscal_year,
-- authority_track, source_family, stage, chamber, committee, component)
-- cannot itself distinguish more than one physical document. See the model's
-- doc comment in schema.prisma for the full trace.

-- 1. Widen expected_state to allow a bundle to report "at least one member
--    verified, required members still missing" without ever claiming
--    `published` (whole-family complete) prematurely. Every existing row's
--    value is already within the new list, so this is additive-only.
ALTER TABLE "defense_budget_expected_source"
  DROP CONSTRAINT "defense_budget_expected_source_state_chk";
ALTER TABLE "defense_budget_expected_source"
  ADD CONSTRAINT "defense_budget_expected_source_state_chk" CHECK (
    "expected_state" IN (
      'expected',
      'not_filed',
      'published',
      'partially_published',
      'superseded',
      'withdrawn',
      'unavailable',
      'review_required'
    )
  );

-- 2. The member manifest itself.
--
-- `expected_fiscal_year`/`expected_authority_track`/`expected_stage`/
-- `expected_source_family`/`expected_component` are an identity snapshot the
-- CALLER asserts, NOT authoritative by themselves -- the trigger below
-- (`defense_budget_source_bundle_member_identity_chk`) re-derives the same
-- five facts from the JOINED `defense_budget_expected_source` row on every
-- INSERT/UPDATE and rejects the write on any mismatch. Without this, a
-- seeding bug that computed the wrong `expected_source_id` (e.g. a Navy or
-- FY2025 row) would attach a member with no structural error at all -- the
-- FK alone only proves the id exists, never that it names the RIGHT source.
CREATE TABLE "defense_budget_source_bundle_member" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "expected_source_id" UUID NOT NULL,
  "member_key" TEXT NOT NULL,
  "volume" TEXT,
  "budget_activity" TEXT,
  "official_url" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT TRUE,
  "member_status" TEXT NOT NULL DEFAULT 'missing',
  "observation_id" UUID,
  "source_document_id" UUID,
  "expected_fiscal_year" INTEGER NOT NULL,
  "expected_authority_track" TEXT NOT NULL,
  "expected_stage" TEXT NOT NULL,
  "expected_source_family" TEXT NOT NULL,
  "expected_component" TEXT,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_source_bundle_member_status_chk" CHECK (
    "member_status" IN ('missing', 'observed', 'verified')
  ),
  CONSTRAINT "defense_budget_source_bundle_member_key_chk" CHECK (
    length("member_key") > 0
  ),
  CONSTRAINT "defense_budget_source_bundle_member_url_chk" CHECK (
    "official_url" ~ '^https://'
  ),
  -- Mirrors defense_budget_expected_source's own track/component CHECKs
  -- exactly, so the snapshot can never assert a value the parent table
  -- itself would refuse.
  CONSTRAINT "defense_budget_source_bundle_member_track_chk" CHECK (
    "expected_authority_track" IN (
      'request', 'authorization', 'appropriations', 'alternative_funding', 'execution'
    )
  ),
  CONSTRAINT "defense_budget_source_bundle_member_component_chk" CHECK (
    "expected_component" IS NULL OR "expected_component" IN ('ARMY', 'NAVY', 'USMC', 'AF', 'SF', 'DW')
  ),
  -- A member cannot be verified without a bound observation and document —
  -- 'verified' is a durable ingestion fact, never an operator's say-so alone.
  CONSTRAINT "defense_budget_source_bundle_member_verified_bound_chk" CHECK (
    "member_status" <> 'verified' OR ("observation_id" IS NOT NULL AND "source_document_id" IS NOT NULL)
  ),
  CONSTRAINT "defense_budget_source_bundle_member_observed_bound_chk" CHECK (
    "member_status" = 'missing' OR "observation_id" IS NOT NULL
  ),
  CONSTRAINT "defense_budget_source_bundle_member_expected_fk"
    FOREIGN KEY ("expected_source_id") REFERENCES "defense_budget_expected_source"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_source_bundle_member_observation_fk"
    FOREIGN KEY ("observation_id") REFERENCES "defense_budget_source_observation"("id")
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "defense_budget_source_bundle_member_document_fk"
    FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE UNIQUE INDEX "defense_budget_source_bundle_member_expected_key_key"
  ON "defense_budget_source_bundle_member"("expected_source_id", "member_key");
CREATE INDEX "defense_budget_source_bundle_member_status_idx"
  ON "defense_budget_source_bundle_member"("expected_source_id", "member_status");
CREATE INDEX "defense_budget_source_bundle_member_observation_idx"
  ON "defense_budget_source_bundle_member"("observation_id");

-- Cross-table identity enforcement: a member's declared identity snapshot
-- MUST equal the actual, live values on the expected_source row it names.
-- Fires on INSERT and on UPDATE of expected_source_id (a member should never
-- be re-parented to a different expected source at all, but if it ever were,
-- this refuses a mismatched re-parent exactly like it refuses a bad insert).
CREATE OR REPLACE FUNCTION defense_budget_source_bundle_member_identity_chk()
RETURNS TRIGGER AS $$
DECLARE
  es RECORD;
BEGIN
  SELECT "fiscal_year", "authority_track", "stage", "source_family", "component"
    INTO es
    FROM "defense_budget_expected_source"
   WHERE "id" = NEW."expected_source_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'defense_budget_source_bundle_member: expected_source_id % does not exist',
      NEW."expected_source_id";
  END IF;

  IF NEW."expected_fiscal_year" IS DISTINCT FROM es."fiscal_year" THEN
    RAISE EXCEPTION
      'defense_budget_source_bundle_member: member declares fiscal_year %, expected_source % is fiscal_year %',
      NEW."expected_fiscal_year", NEW."expected_source_id", es."fiscal_year";
  END IF;
  IF NEW."expected_authority_track" IS DISTINCT FROM es."authority_track" THEN
    RAISE EXCEPTION
      'defense_budget_source_bundle_member: member declares authority_track %, expected_source % is authority_track %',
      NEW."expected_authority_track", NEW."expected_source_id", es."authority_track";
  END IF;
  IF NEW."expected_stage" IS DISTINCT FROM es."stage" THEN
    RAISE EXCEPTION
      'defense_budget_source_bundle_member: member declares stage %, expected_source % is stage %',
      NEW."expected_stage", NEW."expected_source_id", es."stage";
  END IF;
  IF NEW."expected_source_family" IS DISTINCT FROM es."source_family" THEN
    RAISE EXCEPTION
      'defense_budget_source_bundle_member: member declares source_family %, expected_source % is source_family %',
      NEW."expected_source_family", NEW."expected_source_id", es."source_family";
  END IF;
  IF NEW."expected_component" IS DISTINCT FROM es."component" THEN
    RAISE EXCEPTION
      'defense_budget_source_bundle_member: member declares component %, expected_source % is component %',
      NEW."expected_component", NEW."expected_source_id", es."component";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER defense_budget_source_bundle_member_identity_check
  BEFORE INSERT OR UPDATE OF "expected_source_id" ON "defense_budget_source_bundle_member"
  FOR EACH ROW EXECUTE FUNCTION defense_budget_source_bundle_member_identity_chk();

-- 3. Governed operator-attested import audit trail (Part J). INSERT only —
--    the trigger below rejects UPDATE and DELETE unconditionally so a later
--    write can never quietly rewrite or erase what an operator actually did.
CREATE TABLE "defense_budget_governed_import_audit" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "expected_source_id" UUID NOT NULL,
  "bundle_member_id" UUID NOT NULL,
  "observation_id" UUID,
  "operator" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "official_url" TEXT NOT NULL,
  "content_sha256" CHAR(64) NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "archive_bucket" TEXT NOT NULL,
  "archive_s3_key" TEXT NOT NULL,
  "archive_version_id" TEXT,
  "import_command_version" TEXT NOT NULL,
  "identity_checks_jsonb" JSONB NOT NULL,
  "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_budget_governed_import_audit_operator_chk" CHECK (length("operator") > 0),
  CONSTRAINT "defense_budget_governed_import_audit_reason_chk" CHECK (length("reason") > 0),
  CONSTRAINT "defense_budget_governed_import_audit_sha_chk" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "defense_budget_governed_import_audit_byte_size_chk" CHECK ("byte_size" > 0),
  CONSTRAINT "defense_budget_governed_import_audit_expected_fk"
    FOREIGN KEY ("expected_source_id") REFERENCES "defense_budget_expected_source"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_governed_import_audit_member_fk"
    FOREIGN KEY ("bundle_member_id") REFERENCES "defense_budget_source_bundle_member"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "defense_budget_governed_import_audit_observation_fk"
    FOREIGN KEY ("observation_id") REFERENCES "defense_budget_source_observation"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX "defense_budget_governed_import_audit_expected_idx"
  ON "defense_budget_governed_import_audit"("expected_source_id");
CREATE INDEX "defense_budget_governed_import_audit_member_idx"
  ON "defense_budget_governed_import_audit"("bundle_member_id");

CREATE OR REPLACE FUNCTION defense_budget_governed_import_audit_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'defense_budget_governed_import_audit is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER defense_budget_governed_import_audit_no_update
  BEFORE UPDATE ON "defense_budget_governed_import_audit"
  FOR EACH ROW EXECUTE FUNCTION defense_budget_governed_import_audit_immutable();

CREATE TRIGGER defense_budget_governed_import_audit_no_delete
  BEFORE DELETE ON "defense_budget_governed_import_audit"
  FOR EACH ROW EXECUTE FUNCTION defense_budget_governed_import_audit_immutable();
