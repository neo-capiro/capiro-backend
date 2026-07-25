-- District Nexus + Grants, Phase 1 (data foundation, dark). Additive only.
--
-- Adds:
--   1. federal_assistance_award — GLOBAL table (no tenant_id, no RLS), mirrors
--      federal_award's shape/precedent. USAspending financial assistance
--      (award_type_codes 02/03/04/05: block/formula/project grants + coop
--      agreements). Deliberately separate from federal_award — contracts and
--      assistance are different data products with different identity keys
--      and geography semantics; they must never be merged in storage.
--   2. client_grant_nexus — TENANT-scoped + RLS-isolated (review_request
--      template), for client roles in federal assistance that public award
--      data cannot safely infer (subrecipient, project-site, partner, etc).
--      assistance_award_id / grant_opportunity_id are FK-less pointers into
--      the global award/opportunity tables (upsert-only, never deleted from —
--      a hard FK would force cascade semantics onto a table that doesn't need
--      them); joined at read time by application code, not enforced by the DB.
--   3. Nullable boundary-artifact columns on legislative_district — browser-
--      safe GeoJSON artifact metadata built once by
--      build-district-boundary-artifacts, never the raw vendor KML URL.
--
-- Rollback: DROP TABLE "client_grant_nexus"; DROP TABLE "federal_assistance_award";
-- ALTER TABLE "legislative_district" DROP COLUMN "geojson_s3_key", DROP COLUMN
-- "boundary_bbox_json", DROP COLUMN "boundary_centroid_json", DROP COLUMN
-- "boundary_source", DROP COLUMN "boundary_built_at", DROP COLUMN "boundary_hash";
-- All additive — safe to roll back without touching any other table.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. federal_assistance_award (global, no RLS) ------------------------------

CREATE TABLE "federal_assistance_award" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "award_unique_id" TEXT NOT NULL,
    "fain" TEXT,
    "uri" TEXT,
    "award_type_code" TEXT,
    "award_type_label" TEXT,

    "recipient_name" TEXT,
    "recipient_uei" TEXT,
    "parent_recipient_name" TEXT,
    "parent_recipient_uei" TEXT,

    "assistance_listings" JSONB,
    "assistance_listing_number" TEXT,
    "assistance_listing_title" TEXT,
    "funding_opportunity_number" TEXT,
    "sai_number" TEXT,

    "awarding_agency" TEXT,
    "awarding_sub_tier" TEXT,
    "funding_agency" TEXT,
    "funding_sub_tier" TEXT,

    "total_obligated_amount" DECIMAL(18,2),
    "total_outlayed_amount" DECIMAL(18,2),
    "non_federal_funding_amount" DECIMAL(18,2),

    "description" TEXT,
    "start_date" DATE,
    "end_date" DATE,
    "last_modified_date" TIMESTAMPTZ(6),

    "pop_state" TEXT,
    "pop_congressional_district_raw" TEXT,
    "pop_congressional_district" TEXT,
    "pop_cd_vintage" TEXT,
    "pop_city" TEXT,
    "pop_zip" TEXT,
    "pop_country" TEXT,

    "recipient_state" TEXT,
    "recipient_congressional_district_raw" TEXT,
    "recipient_congressional_district" TEXT,
    "recipient_city" TEXT,
    "recipient_zip" TEXT,

    "subaward_count" INTEGER,
    "detail_enriched_at" TIMESTAMPTZ(6),

    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "federal_assistance_award_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "federal_assistance_award_award_unique_id_key"
    ON "federal_assistance_award" ("award_unique_id");

CREATE INDEX "faa_recipient_uei_idx" ON "federal_assistance_award" ("recipient_uei");
CREATE INDEX "faa_pop_district_idx" ON "federal_assistance_award" ("pop_state", "pop_congressional_district");
CREATE INDEX "faa_recipient_district_idx" ON "federal_assistance_award" ("recipient_state", "recipient_congressional_district");
CREATE INDEX "faa_aln_idx" ON "federal_assistance_award" ("assistance_listing_number");
CREATE INDEX "faa_awarding_agency_idx" ON "federal_assistance_award" ("awarding_agency");
CREATE INDEX "faa_end_date_idx" ON "federal_assistance_award" ("end_date");

-- Recipient-name search for the assistance-recipient mapping picker (Phase 1,
-- Workstream B4). The existing contractor-name equivalent search has no such
-- index (federal_award has only btree columns) and pays for it in query time —
-- do not repeat that here.
CREATE INDEX "faa_recipient_name_trgm_idx"
    ON "federal_assistance_award" USING gin (lower("recipient_name") gin_trgm_ops);

-- 2. client_grant_nexus (tenant-scoped, RLS) --------------------------------

CREATE TABLE "client_grant_nexus" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,

    "assistance_award_id" UUID,
    "grant_opportunity_id" TEXT,
    "facility_id" UUID,

    "relationship_type" TEXT NOT NULL,
    "relationship_description" TEXT,
    "attributable_amount" DECIMAL(18,2),
    "beneficiary_count" INTEGER,

    "evidence_source_type" TEXT NOT NULL,
    "evidence_source_ref" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "verification_status" TEXT NOT NULL DEFAULT 'unverified',
    "external_use_approved" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_user_id" UUID,

    "effective_start" DATE,
    "effective_end" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_grant_nexus_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_grant_nexus_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_grant_nexus_client_fkey" FOREIGN KEY ("client_id")
        REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- relationship_type has a plan-fixed closed enum (Rev 2 §6.2) — safe to
    -- enforce in the DB. verification_status does NOT have one yet; per the
    -- plan's own migration-safety guidance it stays free text, validated in
    -- DTOs/service code (same treatment relationship_type itself also gets
    -- at the application layer, on top of this DB check).
    CONSTRAINT "client_grant_nexus_relationship_type_chk"
        CHECK ("relationship_type" IN (
            'direct_recipient', 'subrecipient', 'project_site', 'research_partner',
            'coalition_partner', 'beneficiary', 'matching_contributor', 'opportunity_candidate'
        ))
);

CREATE INDEX "client_grant_nexus_tenant_client_idx" ON "client_grant_nexus" ("tenant_id", "client_id");
CREATE INDEX "client_grant_nexus_tenant_award_idx" ON "client_grant_nexus" ("tenant_id", "assistance_award_id");
CREATE INDEX "client_grant_nexus_tenant_opp_idx" ON "client_grant_nexus" ("tenant_id", "grant_opportunity_id");

ALTER TABLE "client_grant_nexus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_grant_nexus" FORCE ROW LEVEL SECURITY;

CREATE POLICY "client_grant_nexus_select" ON "client_grant_nexus"
    FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "client_grant_nexus_insert" ON "client_grant_nexus"
    FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "client_grant_nexus_update" ON "client_grant_nexus"
    FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "client_grant_nexus_delete" ON "client_grant_nexus"
    FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());

-- 3. legislative_district boundary-artifact metadata (additive, nullable) ---

ALTER TABLE "legislative_district"
    ADD COLUMN "geojson_s3_key" TEXT,
    ADD COLUMN "boundary_bbox_json" JSONB,
    ADD COLUMN "boundary_centroid_json" JSONB,
    ADD COLUMN "boundary_source" TEXT,
    ADD COLUMN "boundary_built_at" TIMESTAMPTZ(6),
    ADD COLUMN "boundary_hash" TEXT;
