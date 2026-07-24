-- Release R3, Step 3.1 — defense budget packages, vehicles, funding positions,
-- and interim-funding (CR) periods.
--
-- GLOBAL public-domain congressional/budget data: NO tenant_id, NO RLS, exactly
-- like source_document / committee_report_provision / bill_budget_line_link.
-- Legislative vehicles, official toplines, CR windows, and public laws are public
-- facts — ONE global record however many tenants read it.
--
-- Runtime grants: capiro_app needs no explicit GRANT here. The
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public` installed by
-- 20260502020000_capiro_app_role auto-grants SELECT/INSERT/UPDATE/DELETE to
-- capiro_app on every relation the migration owner creates. This matches how the
-- other global budget tables were created (see 20260607210000_add_committee_report_provision,
-- which likewise issues no GRANT).
--
-- Purely additive: no existing table, column, index, or policy is touched.
--
-- Money: every amount is DECIMAL(14,2) in MILLIONS of dollars. Decimal (not float)
-- so a reported figure round-trips exactly, and 14,2 holds a national-defense
-- total (~1,010,000.00 $M) with room to spare.
--
-- ROLLBACK: drop in reverse dependency order —
--   DROP TABLE "budget_interim_funding_period", "funding_position",
--              "budget_package_vehicle", "budget_package";
-- No other object depends on them.

-- ── budget_package: one (domain, fiscal year) budget cycle ───────────────────
CREATE TABLE "budget_package" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "budget_package_pkey" PRIMARY KEY ("id")
);
-- One package per domain per fiscal year (§6.5: "no duplicate (domain, fiscalYear)").
CREATE UNIQUE INDEX "budget_package_domain_fy_key" ON "budget_package" ("domain", "fiscal_year");
CREATE INDEX "budget_package_domain_fy_idx" ON "budget_package" ("domain", "fiscal_year");

-- ── budget_package_vehicle: the bills/reports/laws carrying the cycle ────────
-- Deliberately NOT unique on (package_id, track, stage): a chamber may move more
-- than one vehicle, and omnibus/minibus/supplemental vehicles coexist at a stage
-- (§5 edge cases 21-22).
CREATE TABLE "budget_package_vehicle" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" UUID NOT NULL,
    "track" VARCHAR(24) NOT NULL,
    "stage" VARCHAR(16) NOT NULL,
    "bill_id" TEXT,
    "report_number" TEXT,
    "public_law" TEXT,
    "chamber" VARCHAR(16),
    "label" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'introduced',
    "status_at" TIMESTAMPTZ(6),
    "source_document_id" UUID,
    "source_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "budget_package_vehicle_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_package_vehicle_package_id_fkey" FOREIGN KEY ("package_id")
        REFERENCES "budget_package"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "budget_package_vehicle_source_document_id_fkey" FOREIGN KEY ("source_document_id")
        REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "budget_package_vehicle_package_track_stage_idx"
    ON "budget_package_vehicle" ("package_id", "track", "stage");
CREATE INDEX "budget_package_vehicle_bill_idx" ON "budget_package_vehicle" ("bill_id");
CREATE INDEX "budget_package_vehicle_source_document_idx"
    ON "budget_package_vehicle" ("source_document_id");
-- No FK on bill_id: congress_bill is loaded by a separate pipeline and a vehicle
-- can be recorded before its bill row lands. Orphan bill ids are reported by
-- verify-defense-budget-packages (§3.7) rather than blocked at write time.

-- ── funding_position: one officially-sourced topline, in MILLIONS ────────────
CREATE TABLE "funding_position" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "bill_id" TEXT,
    "fiscal_year" INTEGER NOT NULL,
    "vehicle_class" VARCHAR(24) NOT NULL,
    "stage" VARCHAR(16) NOT NULL,
    "scope" VARCHAR(40) NOT NULL,
    "amount_millions" DECIMAL(14,2) NOT NULL,
    "effective_date" TIMESTAMPTZ(6),
    "source_document_id" UUID,
    "source_url" TEXT,
    "source_page" INTEGER,
    "note" TEXT,
    "verification_status" VARCHAR(16) NOT NULL DEFAULT 'extracted',
    "verified_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "funding_position_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "funding_position_package_id_fkey" FOREIGN KEY ("package_id")
        REFERENCES "budget_package"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "funding_position_vehicle_id_fkey" FOREIGN KEY ("vehicle_id")
        REFERENCES "budget_package_vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "funding_position_source_document_id_fkey" FOREIGN KEY ("source_document_id")
        REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "funding_position_natural_key_idx"
    ON "funding_position" ("package_id", "vehicle_id", "fiscal_year", "vehicle_class", "stage", "scope");
CREATE INDEX "funding_position_package_stage_scope_idx"
    ON "funding_position" ("package_id", "stage", "scope");
CREATE INDEX "funding_position_bill_fy_idx" ON "funding_position" ("bill_id", "fiscal_year");
CREATE INDEX "funding_position_verification_idx" ON "funding_position" ("verification_status");
CREATE INDEX "funding_position_source_document_idx" ON "funding_position" ("source_document_id");

-- LIVE-row uniqueness. Partial + functional because:
--   * vehicle_id is nullable and Postgres treats NULLs as distinct, so a plain
--     unique index would let duplicate package-level (vehicle-less) toplines in —
--     hence COALESCE to the nil UUID;
--   * a 'superseded' row must be KEPT for audit while its replacement takes the
--     same natural key — hence the WHERE clause. Exactly one live row can exist
--     per (package, vehicle, FY, vehicle class, stage, scope).
-- Prisma 5 cannot express either property, so it lives here as raw SQL (same
-- approach as program_element_delta's partial natural key).
CREATE UNIQUE INDEX "funding_position_live_natural_key"
    ON "funding_position" (
        "package_id",
        (COALESCE("vehicle_id", '00000000-0000-0000-0000-000000000000'::uuid)),
        "fiscal_year",
        "vehicle_class",
        "stage",
        "scope"
    )
    WHERE "verification_status" <> 'superseded';

-- Units guard: a topline in MILLIONS is positive and cannot plausibly exceed
-- $100T ($100,000,000 M). A row that trips this is a units error (dollars or
-- thousands loaded as millions), which §3.7 must never be able to commit.
ALTER TABLE "funding_position"
    ADD CONSTRAINT "funding_position_amount_millions_sane"
    CHECK ("amount_millions" >= 0 AND "amount_millions" <= 100000000);

-- ── budget_interim_funding_period: CR / lapse windows per fiscal year ────────
CREATE TABLE "budget_interim_funding_period" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "start_date" TIMESTAMPTZ(6),
    "coverage_through" TIMESTAMPTZ(6),
    "vehicle_label" TEXT NOT NULL,
    "bill_id" TEXT,
    "public_law" TEXT,
    "shutdown_days" INTEGER,
    "notes" TEXT,
    "source_document_id" UUID,
    "source_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "budget_interim_funding_period_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_interim_funding_period_source_document_id_fkey" FOREIGN KEY ("source_document_id")
        REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "budget_interim_funding_period_natural_key"
    ON "budget_interim_funding_period" ("domain", "fiscal_year", "sequence");
CREATE INDEX "budget_interim_funding_period_domain_fy_seq_idx"
    ON "budget_interim_funding_period" ("domain", "fiscal_year", "sequence");
CREATE INDEX "budget_interim_funding_period_bill_idx"
    ON "budget_interim_funding_period" ("bill_id");

-- A CR cannot fund through a date before it started, and a lapse is a
-- non-negative number of days (§3.7 "impossible coverage dates").
ALTER TABLE "budget_interim_funding_period"
    ADD CONSTRAINT "budget_interim_funding_period_coverage_after_start"
    CHECK ("start_date" IS NULL OR "coverage_through" IS NULL OR "coverage_through" >= "start_date");
ALTER TABLE "budget_interim_funding_period"
    ADD CONSTRAINT "budget_interim_funding_period_sequence_positive"
    CHECK ("sequence" >= 1);
ALTER TABLE "budget_interim_funding_period"
    ADD CONSTRAINT "budget_interim_funding_period_shutdown_days_nonneg"
    CHECK ("shutdown_days" IS NULL OR "shutdown_days" >= 0);
