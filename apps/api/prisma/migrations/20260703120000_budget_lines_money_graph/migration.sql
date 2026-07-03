-- Budget Lines / money graph (BL-0 — budget-lines-ui-implementation-plan.md §2;
-- object model per defense-money-graph-consolidated-plan.md §1.2/§1.3/§1.6).
--
-- ADDITIVE ONLY — five brand-new GLOBAL tables (no tenant_id / RLS: public-domain
-- budget data, same as program_element / federal_award). No ALTER/DROP of any
-- existing table. All rows are derived + regenerable; derive verbs delete-and-
-- rewrite their own derived_by cohort.

-- ── budget_action (§1.2): normalized committee/appropriations events ─────────
CREATE TABLE IF NOT EXISTS "budget_action" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pe_code" VARCHAR(16) NOT NULL,
    "fy" INTEGER NOT NULL,
    "stage" VARCHAR(12) NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(14,2),
    "baseline" VARCHAR(12) NOT NULL,
    "note" TEXT,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "derived_by" VARCHAR(48) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_action_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "budget_action_natural_key" ON "budget_action" ("pe_code", "fy", "stage", "action");
CREATE INDEX IF NOT EXISTS "budget_action_pe_code_idx" ON "budget_action" ("pe_code");
CREATE INDEX IF NOT EXISTS "budget_action_fy_stage_idx" ON "budget_action" ("fy", "stage");
CREATE INDEX IF NOT EXISTS "budget_action_action_idx" ON "budget_action" ("action");

-- ── budget_line_relationship (§1.3): typed evidence-bearing edges ────────────
CREATE TABLE IF NOT EXISTS "budget_line_relationship" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "from_pe_code" VARCHAR(16) NOT NULL,
    "to_pe_code" VARCHAR(16) NOT NULL,
    "rel_type" VARCHAR(40) NOT NULL,
    "confidence" VARCHAR(8) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'accepted',
    "evidence" TEXT NOT NULL,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "derived_by" VARCHAR(48) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_line_relationship_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "budget_line_relationship_natural_key" ON "budget_line_relationship" ("from_pe_code", "to_pe_code", "rel_type");
CREATE INDEX IF NOT EXISTS "budget_line_relationship_from_idx" ON "budget_line_relationship" ("from_pe_code");
CREATE INDEX IF NOT EXISTS "budget_line_relationship_to_idx" ON "budget_line_relationship" ("to_pe_code");
CREATE INDEX IF NOT EXISTS "budget_line_relationship_type_idx" ON "budget_line_relationship" ("rel_type");

-- ── capability (§1.6): curated demand-side object ────────────────────────────
CREATE TABLE IF NOT EXISTS "capability" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(32) NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "taxonomy_path" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "capability_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "capability_slug_key" ON "capability" ("slug");

-- ── capability_budget_line_match: auditable capability ↔ line matches ────────
CREATE TABLE IF NOT EXISTS "capability_budget_line_match" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "capability_id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "confidence" VARCHAR(8) NOT NULL,
    "matched_on" TEXT NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'accepted',
    "derived_by" VARCHAR(48) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "capability_budget_line_match_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "capability_budget_line_match_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capability"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "capability_budget_line_match_natural_key" ON "capability_budget_line_match" ("capability_id", "pe_code");
CREATE INDEX IF NOT EXISTS "capability_budget_line_match_pe_idx" ON "capability_budget_line_match" ("pe_code");

-- ── program_element_intelligence_cache: catalog-sortable engine outputs ──────
CREATE TABLE IF NOT EXISTS "program_element_intelligence_cache" (
    "pe_code" VARCHAR(16) NOT NULL,
    "line_type" VARCHAR(20),
    "maturity" INTEGER,
    "maturity_jsonb" JSONB NOT NULL DEFAULT '{}',
    "approp_tier" VARCHAR(8),
    "approp_score" INTEGER,
    "approp_jsonb" JSONB NOT NULL DEFAULT '{}',
    "signal_type" VARCHAR(16),
    "signal_tone" VARCHAR(12),
    "signal_fy" INTEGER,
    "valley_of_death" BOOLEAN NOT NULL DEFAULT false,
    "posture_jsonb" JSONB NOT NULL DEFAULT '{}',
    "anomalies_jsonb" JSONB NOT NULL DEFAULT '[]',
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "program_element_intelligence_cache_pkey" PRIMARY KEY ("pe_code")
);
CREATE INDEX IF NOT EXISTS "pe_intelligence_cache_line_type_idx" ON "program_element_intelligence_cache" ("line_type");
CREATE INDEX IF NOT EXISTS "pe_intelligence_cache_approp_idx" ON "program_element_intelligence_cache" ("approp_score");
CREATE INDEX IF NOT EXISTS "pe_intelligence_cache_signal_idx" ON "program_element_intelligence_cache" ("signal_type");
