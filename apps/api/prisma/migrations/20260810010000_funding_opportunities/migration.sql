-- Funding Opportunities + automatic federal-contractor matching.
--
-- ADDITIVE ONLY. One new table, four new columns on sam_opportunity, five on
-- client_intel_mapping, three new indexes on sam_opportunity. No DROP, no type
-- change, no NOT NULL without a default on an existing table. Every statement is
-- guarded so a retry after a partial failure is a no-op.
--
-- Table names are checked by apps/api/src/prisma/migration-table-names.spec.ts —
-- `client_intel_mapping` and `sam_opportunity` are the real @@map targets
-- (singular, both of them; `clients` is the plural one). Getting that wrong is
-- what broke main on 2026-07-28.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. client_funding_opportunity — the durable, tenant-scoped workflow record.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "client_funding_opportunity" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    -- federal_grant.id is TEXT (a Grants.gov opportunity id), sam_opportunity.id
    -- is UUID. Deliberately FK-less: both are global upsert-only catalogs and a
    -- hard FK would force cascade semantics onto tables nothing deletes from.
    "grant_opportunity_id" TEXT,
    "sam_opportunity_id" UUID,
    "workflow_status" VARCHAR(16) NOT NULL DEFAULT 'suggested',
    "owner_user_id" UUID,
    "facility_id" UUID,
    "notes" TEXT,
    "relevance_score" INTEGER,
    "match_signals_jsonb" JSONB NOT NULL DEFAULT '[]',
    "eligibility_state" VARCHAR(16),
    "eligibility_reason" TEXT,
    "evidence_source_type" VARCHAR(48) NOT NULL,
    "user_created" BOOLEAN NOT NULL DEFAULT false,
    "stale_at" TIMESTAMPTZ(6),
    "dismissed_reason" TEXT,
    "outcome_note" TEXT,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "client_funding_opportunity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_funding_opportunity_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_funding_opportunity_client_fkey" FOREIGN KEY ("client_id")
        REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_funding_opportunity_source_chk"
        CHECK ("source" IN ('grants_gov', 'sam_gov')),
    -- EXACTLY ONE source record, and it must be the one `source` names. Enforced
    -- here rather than trusted to the writer: a row pointing at a SAM notice
    -- while claiming source='grants_gov' would be read by the grant rail and
    -- silently produce nothing.
    CONSTRAINT "client_funding_opportunity_one_source_chk" CHECK (
      ("source" = 'grants_gov' AND "grant_opportunity_id" IS NOT NULL AND "sam_opportunity_id" IS NULL)
      OR
      ("source" = 'sam_gov' AND "sam_opportunity_id" IS NOT NULL AND "grant_opportunity_id" IS NULL)
    ),
    CONSTRAINT "client_funding_opportunity_status_chk"
        CHECK ("workflow_status" IN ('suggested', 'saved', 'pursuing', 'dismissed', 'won', 'lost', 'expired')),
    CONSTRAINT "client_funding_opportunity_eligibility_chk"
        CHECK ("eligibility_state" IS NULL OR "eligibility_state" IN ('eligible', 'ineligible', 'needs_review', 'unknown'))
);

-- ONE workflow row per (tenant, client, source opportunity).
--
-- These are PARTIAL unique indexes, which is the whole point: Postgres treats
-- NULLs as distinct, so a single unique index over
-- (tenant_id, client_id, grant_opportunity_id, sam_opportunity_id) would admit
-- unlimited duplicate SAM rows (all with grant_opportunity_id NULL) and vice
-- versa. Prisma cannot express a partial unique index, so it lives only here —
-- and no writer may use `upsert` against these keys (Prisma cannot target them);
-- the writers do find-then-create-or-update.
CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_grant_uniq"
    ON "client_funding_opportunity" ("tenant_id", "client_id", "grant_opportunity_id")
    WHERE "grant_opportunity_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_sam_uniq"
    ON "client_funding_opportunity" ("tenant_id", "client_id", "sam_opportunity_id")
    WHERE "sam_opportunity_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "client_funding_opportunity_tenant_client_status_idx"
    ON "client_funding_opportunity" ("tenant_id", "client_id", "workflow_status");
CREATE INDEX IF NOT EXISTS "client_funding_opportunity_tenant_grant_idx"
    ON "client_funding_opportunity" ("tenant_id", "grant_opportunity_id");
CREATE INDEX IF NOT EXISTS "client_funding_opportunity_tenant_sam_idx"
    ON "client_funding_opportunity" ("tenant_id", "sam_opportunity_id");
CREATE INDEX IF NOT EXISTS "client_funding_opportunity_tenant_owner_idx"
    ON "client_funding_opportunity" ("tenant_id", "owner_user_id");

-- RLS, per the alert_generation_record / client_grant_nexus template. FORCE so
-- the table owner is not exempt either.
ALTER TABLE "client_funding_opportunity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_funding_opportunity" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_funding_opportunity' AND policyname = 'client_funding_opportunity_select'
  ) THEN
    CREATE POLICY "client_funding_opportunity_select" ON "client_funding_opportunity"
        FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_funding_opportunity' AND policyname = 'client_funding_opportunity_insert'
  ) THEN
    CREATE POLICY "client_funding_opportunity_insert" ON "client_funding_opportunity"
        FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_funding_opportunity' AND policyname = 'client_funding_opportunity_update'
  ) THEN
    CREATE POLICY "client_funding_opportunity_update" ON "client_funding_opportunity"
        FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
        WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_funding_opportunity' AND policyname = 'client_funding_opportunity_delete'
  ) THEN
    CREATE POLICY "client_funding_opportunity_delete" ON "client_funding_opportunity"
        FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. sam_opportunity — source fields the notice already carries but we dropped.
--
-- Every one of these is present on the search-v2 record the sync already stores
-- verbatim in raw_jsonb, so this is NOT a second ingestion pipeline: the columns
-- are promoted out of raw by backfill-sam-opportunity-fields.ts, and the sync
-- writes them going forward.
--
-- base_type matters for correctness, not completeness: an amended notice carries
-- type='Solicitation' with baseType='Presolicitation', and the UI must not show
-- a sources-sought notice as an open solicitation.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "sam_opportunity"
  ADD COLUMN IF NOT EXISTS "base_type" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "sub_agency" TEXT,
  ADD COLUMN IF NOT EXISTS "set_aside" TEXT,
  ADD COLUMN IF NOT EXISTS "set_aside_code" VARCHAR(16);

CREATE INDEX IF NOT EXISTS "sam_opportunity_active_type_deadline_idx"
    ON "sam_opportunity" ("active", "notice_type", "response_deadline");
CREATE INDEX IF NOT EXISTS "sam_opportunity_set_aside_code_idx"
    ON "sam_opportunity" ("set_aside_code");
CREATE INDEX IF NOT EXISTS "sam_opportunity_solicitation_number_idx"
    ON "sam_opportunity" ("solicitation_number");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. client_intel_mapping — record WHY a mapping exists, and WHOSE entity it is.
--
-- All nullable, no backfill. A pre-existing row's basis was never recorded, and
-- writing 'exact_uei' or 'self' across the table would invent a reviewed
-- assertion nobody made — the read path reports those rows as
-- 'legacy_unrecorded' instead.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "client_intel_mapping"
  ADD COLUMN IF NOT EXISTS "match_basis" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "match_tier" INTEGER,
  ADD COLUMN IF NOT EXISTS "match_evidence_jsonb" JSONB,
  ADD COLUMN IF NOT EXISTS "relationship_type" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "roll_up_awards" BOOLEAN;

-- Not a CHECK constraint: client_intel_mapping is written by several existing
-- code paths this migration does not touch, and a CHECK would turn any of them
-- passing an unexpected basis into a 500 at write time. The vocabulary is
-- enforced in TypeScript, where a violation is a compile error instead.
COMMENT ON COLUMN "client_intel_mapping"."match_basis" IS
  'exact_uei | exact_cage | exact_legal_name_corroborated | exact_legal_name | fuzzy_name | manual_pin | legacy_unrecorded';
COMMENT ON COLUMN "client_intel_mapping"."relationship_type" IS
  'self | alias | former_name | parent | subsidiary | operating_unit';
