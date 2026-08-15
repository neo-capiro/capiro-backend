-- MakeGov/Tango subaward intelligence substrate.
--
-- GLOBAL PUBLIC REFERENCE DATA: no tenant_id and no RLS. Tenant/client exposure
-- is decided by the read service through confirmed client identity mappings.
-- This table is additive and does not replace Capiro's first-party
-- federal_award or federal_assistance_award rails.
--
-- Money is nullable and NULL is not zero. A negative subaward amount is allowed
-- because source modifications/deobligations can be negative.

CREATE TABLE IF NOT EXISTS "tango_subaward" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "provider_key" TEXT NOT NULL,
  "award_key" TEXT,
  "prime_award_key" TEXT,
  "piid" VARCHAR(64),
  "subaward_number" VARCHAR(128),
  "subaward_type" VARCHAR(64),
  "subaward_amount" NUMERIC(20,2),
  "action_date" DATE,
  "fiscal_year" INTEGER,
  "description" TEXT,
  "naics_code" VARCHAR(12),

  "prime_recipient_uei" VARCHAR(12),
  "prime_recipient_name" TEXT,
  "prime_parent_uei" VARCHAR(12),
  "prime_parent_name" TEXT,

  "subawardee_uei" VARCHAR(12),
  "subawardee_name" TEXT,
  "subawardee_parent_uei" VARCHAR(12),
  "subawardee_parent_name" TEXT,

  "awarding_agency" TEXT,
  "awarding_office" TEXT,
  "funding_agency" TEXT,
  "funding_office" TEXT,

  "pop_country" VARCHAR(3),
  "pop_state" VARCHAR(8),
  "pop_city" TEXT,
  "pop_zip" VARCHAR(16),
  "pop_congressional_district" VARCHAR(8),

  "source_url" TEXT,
  "provider_modified_at" TIMESTAMPTZ(6),
  "content_sha256" VARCHAR(64) NOT NULL,
  "normalized_jsonb" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,

  "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tango_subaward_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tango_subaward_provider_key_key" UNIQUE ("provider_key"),
  CONSTRAINT "tango_subaward_content_sha256_format" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tango_subaward_fiscal_year_range" CHECK ("fiscal_year" IS NULL OR "fiscal_year" BETWEEN 1900 AND 2200)
);

CREATE INDEX IF NOT EXISTS "tango_subaward_award_key_idx"
  ON "tango_subaward" ("award_key");
CREATE INDEX IF NOT EXISTS "tango_subaward_prime_uei_idx"
  ON "tango_subaward" ("prime_recipient_uei");
CREATE INDEX IF NOT EXISTS "tango_subaward_recipient_uei_idx"
  ON "tango_subaward" ("subawardee_uei");
CREATE INDEX IF NOT EXISTS "tango_subaward_action_date_idx"
  ON "tango_subaward" ("action_date" DESC, "provider_key");
CREATE INDEX IF NOT EXISTS "tango_subaward_district_idx"
  ON "tango_subaward" ("pop_state", "pop_congressional_district", "action_date" DESC);
CREATE INDEX IF NOT EXISTS "tango_subaward_awarding_agency_idx"
  ON "tango_subaward" ("awarding_agency", "action_date" DESC);
CREATE INDEX IF NOT EXISTS "tango_subaward_naics_idx"
  ON "tango_subaward" ("naics_code", "action_date" DESC);

-- Dedicated resumable high-water mark. Kept separate from tango_sync_checkpoint
-- because that table's resource vocabulary predates subawards and is intentionally
-- CHECK-constrained. A complete run advances window_end; an interrupted/capped
-- run retains its window and next page.
CREATE TABLE IF NOT EXISTS "tango_subaward_sync_checkpoint" (
  "sync_key" VARCHAR(64) NOT NULL,
  "window_start" TIMESTAMPTZ(6),
  "window_end" TIMESTAMPTZ(6),
  "next_page" INTEGER NOT NULL DEFAULT 1,
  "completeness" VARCHAR(16) NOT NULL DEFAULT 'complete',
  "rows_processed" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tango_subaward_sync_checkpoint_pkey" PRIMARY KEY ("sync_key"),
  CONSTRAINT "tango_subaward_sync_checkpoint_page" CHECK ("next_page" >= 1),
  CONSTRAINT "tango_subaward_sync_checkpoint_completeness" CHECK ("completeness" IN ('complete','in_progress'))
);
