-- Legislative-timeline plan LEG-B (consolidated plan §1.5): evidence-typed
-- bill ↔ budget-line links + reserved bill attribution on budget_action.
-- ADDITIVE ONLY: one new GLOBAL table + one nullable column. No ALTER/DROP of
-- existing columns. CongressBill.peCodes stays as the GIN-filtered list index;
-- this table is the system of record for WHY a link exists.

CREATE TABLE IF NOT EXISTS "bill_budget_line_link" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bill_id" TEXT NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "link_type" VARCHAR(24) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "evidence" TEXT NOT NULL,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(12) NOT NULL DEFAULT 'accepted',
    "derived_by" VARCHAR(48) NOT NULL,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "bill_budget_line_link_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bill_budget_line_link_natural_key" ON "bill_budget_line_link" ("bill_id", "pe_code", "link_type");
CREATE INDEX IF NOT EXISTS "bill_budget_line_link_pe_idx" ON "bill_budget_line_link" ("pe_code");
CREATE INDEX IF NOT EXISTS "bill_budget_line_link_bill_idx" ON "bill_budget_line_link" ("bill_id");

-- Reserved: bill that asserted a derived budget action, when attributable.
ALTER TABLE "budget_action" ADD COLUMN IF NOT EXISTS "bill_id" TEXT;
