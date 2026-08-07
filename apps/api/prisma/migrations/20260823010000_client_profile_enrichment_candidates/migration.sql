-- Funding Opportunities P20 — client profile enrichment review workflow.
--
-- WHY A NEW TABLE, NOT tango_resource_link OR client_intel_mapping
-- -------------------------------------------------------------------
-- `tango_resource_link` (P15) links a Tango resource into one of Capiro's own
-- GLOBAL reference tables — `assertKnownLocalType` in tango-store.service.ts
-- explicitly refuses a tenant-owned local resource type, and `clients` is
-- tenant-owned. `client_intel_mapping` (P05) answers a different question —
-- "is this external entity the SAME LEGAL ENTITY as this client" — not "should
-- this specific FIELD on the client's own profile be updated to this value".
-- Neither fits, so this is a new, purpose-built, TENANT-SCOPED table.
--
-- WHAT A ROW IS
-- -------------------------------------------------------------------
-- One proposed change to ONE field on ONE client's profile, sourced from Tango
-- entity data, pending human review. `current_value_jsonb` is a SNAPSHOT of the
-- client's value AT PROPOSAL TIME (so a reviewer sees exactly what would
-- change even if the client's live value has since moved on) — never re-read
-- live at review time, which would make an old candidate's diff misleading.
--
-- DURABILITY: NEVER RE-PROPOSE THE SAME CONTENT
-- -------------------------------------------------------------------
-- A rejected (or accepted) candidate must never be silently re-created by a
-- later sync proposing the IDENTICAL field+value combination — same
-- never-resurrect principle as `tango_resource_link` (P15) and
-- `client_intel_mapping` (P05) before it. Enforced here by a unique index on
-- (tenant_id, client_id, source, field, content_hash): the SERVICE checks for
-- an existing row before inserting (idempotent propose, like P15's
-- proposeLink), and this index is the backstop against a race doing the same
-- thing twice. `content_hash` (not the raw JSONB) is indexed because Postgres
-- cannot uniquely index an unbounded JSONB value directly, and because a
-- canonicalized hash is stable under key-order noise the same way P15's
-- checkpoint/snapshot hashing already is.
--
-- A DIFFERENT proposed value for the SAME field is a NEW row, not a collision
-- — the real-world fact changed, and durability protects a SPECIFIC rejected
-- suggestion, not "never suggest anything for this field again forever".
--
-- NO "ACCEPT ALL": there is no bulk-status column or bulk endpoint target
-- here by design — every row is reviewed by its own primary key, one at a
-- time, enforced by the SERVICE layer having no bulk-accept method at all
-- (this phase's own acceptance bar: "no accept-all for certifications" —
-- generalized here to no accept-all for anything, which trivially satisfies
-- the narrower rule).
--
-- REVIEW STATE IS ALL-OR-NOTHING
-- -------------------------------------------------------------------
-- A pending row carries neither reviewer nor timestamp; a reviewed row (either
-- direction) carries both. Enforced by CHECK, not left to the writer — a
-- reviewed row missing WHO or WHEN is not reviewable evidence.
--
-- RLS
-- -------------------------------------------------------------------
-- Tenant-scoped, so RLS ENABLED + FORCED with the standard four
-- rls_bypass()/current_tenant_id() policies, per the client_funding_opportunity
-- (P07) / client_grant_nexus template.
--
-- Every statement is retry-safe. A failed migration blocks every later one, so
-- a retry after a partial failure must be a no-op.

CREATE TABLE IF NOT EXISTS "client_profile_enrichment_candidate" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'tango',
    -- 'naicsCodes' | 'pscCodes' | 'setAsideCertifications' | 'cageCode'. The
    -- CAMELCASE spelling matches the Client model's own field names verbatim
    -- (not the tango_snapshot's snake_case), because this row is fundamentally
    -- about a CLIENT field, and a reviewer or future migration reading this
    -- table should not need a second translation table to know which column
    -- a row targets.
    "field" VARCHAR(32) NOT NULL,
    "current_value_jsonb" JSONB,
    "proposed_value_jsonb" JSONB NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "client_profile_enrichment_candidate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_profile_enrichment_candidate_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_profile_enrichment_candidate_client_fkey" FOREIGN KEY ("client_id")
        REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_profile_enrichment_candidate_source_chk"
        CHECK ("source" IN ('tango')),
    CONSTRAINT "client_profile_enrichment_candidate_field_chk"
        CHECK ("field" IN ('naicsCodes', 'pscCodes', 'setAsideCertifications', 'cageCode')),
    CONSTRAINT "client_profile_enrichment_candidate_status_chk"
        CHECK ("status" IN ('pending', 'accepted', 'rejected')),
    CONSTRAINT "client_profile_enrichment_candidate_review_chk" CHECK (
      ("status" = 'pending' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL)
      OR
      ("status" != 'pending' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_profile_enrichment_candidate_content_uniq"
    ON "client_profile_enrichment_candidate" ("tenant_id", "client_id", "source", "field", "content_hash");

CREATE INDEX IF NOT EXISTS "client_profile_enrichment_candidate_pending_idx"
    ON "client_profile_enrichment_candidate" ("tenant_id", "status");

ALTER TABLE "client_profile_enrichment_candidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_profile_enrichment_candidate" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_profile_enrichment_candidate' AND policyname = 'client_profile_enrichment_candidate_select'
  ) THEN
    CREATE POLICY "client_profile_enrichment_candidate_select" ON "client_profile_enrichment_candidate"
        FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_profile_enrichment_candidate' AND policyname = 'client_profile_enrichment_candidate_insert'
  ) THEN
    CREATE POLICY "client_profile_enrichment_candidate_insert" ON "client_profile_enrichment_candidate"
        FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_profile_enrichment_candidate' AND policyname = 'client_profile_enrichment_candidate_update'
  ) THEN
    CREATE POLICY "client_profile_enrichment_candidate_update" ON "client_profile_enrichment_candidate"
        FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
        WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_profile_enrichment_candidate' AND policyname = 'client_profile_enrichment_candidate_delete'
  ) THEN
    CREATE POLICY "client_profile_enrichment_candidate_delete" ON "client_profile_enrichment_candidate"
        FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END $$;
