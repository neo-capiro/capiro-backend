-- CreateTable: regulatory_comment
-- GLOBAL table, no tenant_id, no RLS — same posture as regulatory_docket,
-- fara_registration, federal_register_document. Populated ON DEMAND by a
-- live per-client search against Regulations.gov's own comments API at
-- Advocacy History Fill-time, not a bulk historical crawl (see the model's
-- own schema.prisma comment for the volume rationale: a single docket can
-- carry 250K+ comments platform-wide).
CREATE TABLE "regulatory_comment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "comment_id" TEXT NOT NULL,
    "docket_id" TEXT,
    "agency_id" TEXT,
    "title" TEXT NOT NULL,
    "comment_text" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "organization" TEXT,
    "city" TEXT,
    "state_province" TEXT,
    "country" TEXT,
    "posted_date" TIMESTAMPTZ(6),
    "source_url" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "regulatory_comment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "regulatory_comment_comment_id_key" ON "regulatory_comment"("comment_id");
CREATE INDEX "regulatory_comment_docket_id_idx" ON "regulatory_comment"("docket_id");
CREATE INDEX "regulatory_comment_organization_idx" ON "regulatory_comment"("organization");
CREATE INDEX "regulatory_comment_last_name_first_name_idx" ON "regulatory_comment"("last_name", "first_name");
