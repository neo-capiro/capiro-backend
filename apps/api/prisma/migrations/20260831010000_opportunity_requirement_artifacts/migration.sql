-- Funding Opportunities P31 — evidence-bound requirement extraction artifacts.
--
-- TWO TABLES, AND THE SPLIT IS THE DESIGN
-- -------------------------------------------------------------------
-- `opportunity_requirement`        GLOBAL. A candidate assertion about a public
--                                  federal document, bound to the exact bytes
--                                  and character range it came from.
-- `opportunity_requirement_review` TENANT-SCOPED, RLS ENABLED + FORCED. One
--                                  team's decision about that assertion.
--
-- "This solicitation requires a facility clearance at paragraph 3.2" is a fact
-- about a public document — the same fact for every tenant, extracted once. "We
-- reviewed that and accepted it" is a fact about ONE team. Storing them in one
-- table would mean either re-extracting the same document per tenant (wasteful,
-- and two tenants could get different answers from the same bytes) or putting a
-- tenant's review decision on a row every tenant can see.
--
-- NO ASSERTION WITHOUT EVIDENCE
-- -------------------------------------------------------------------
-- Every requirement row REQUIRES:
--
--   `attachment_id` + `attachment_content_sha256`  which document, which BYTES.
--   `source_excerpt`                               the verbatim quote.
--   `excerpt_start` + `excerpt_end`                where in the text it sits.
--
-- All NOT NULL, all enforced by the database rather than by the extractor. An
-- assertion with no citation is exactly what this phase exists to make
-- impossible, and a NULLable column is a promise the schema does not keep.
--
-- The span is checked for internal consistency too (`end > start`), and the
-- excerpt's length must MATCH the span. An excerpt longer than the range it
-- claims to come from is a paraphrase wearing a citation.
--
-- A CHANGED DOCUMENT INVALIDATES ITS CANDIDATES
-- -------------------------------------------------------------------
-- `attachment_content_sha256` is the hash of the bytes the excerpt was taken
-- from — the same binding P30's text rows carry. When an agency reposts a
-- document it archives under a NEW hash (P29's key IS the hash), and every
-- candidate bound to the old one is stale by construction rather than by a
-- cleanup job that might not run. `superseded_at` records when a sync noticed.
--
-- MODEL OUTPUT IS A CANDIDATE, NEVER TRUTH
-- -------------------------------------------------------------------
-- `extraction_method` and `extraction_model` are NOT NULL. There is no way to
-- store a requirement without recording what produced it, so "the machine said
-- so" and "a human confirmed it" can never be conflated on a read.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "opportunity_requirement" (
    "id"                          UUID NOT NULL DEFAULT uuid_generate_v4(),

    -- What document. Soft pointers, no FK — same reasoning as every other
    -- cross-table reference in this program.
    "attachment_id"               UUID NOT NULL,
    "attachment_content_sha256"   TEXT NOT NULL,
    -- Convenience denormalization so the detail surface can read every
    -- requirement for a solicitation without joining through attachments.
    "sam_opportunity_id"          UUID,

    -- What kind of requirement. Bounded; see the CHECK below.
    "requirement_type"            TEXT NOT NULL,
    -- One sentence, in Capiro's words, of what the excerpt requires.
    "statement"                   TEXT NOT NULL,

    -- THE EVIDENCE. All NOT NULL.
    "source_excerpt"              TEXT NOT NULL,
    "excerpt_start"               INTEGER NOT NULL,
    "excerpt_end"                 INTEGER NOT NULL,
    -- The page, when the extraction method knows one. Genuinely optional: a
    -- plain-text extraction has character offsets and no pages.
    "source_page"                 INTEGER,

    -- What produced this. Both NOT NULL, so "the machine said so" and "a human
    -- confirmed it" can never be conflated.
    "extraction_method"           TEXT NOT NULL,
    "extraction_model"            TEXT NOT NULL,
    -- Evidence quality, never a probability that the requirement is real.
    "confidence"                  TEXT NOT NULL,

    -- Set when a later sync observed the document change under this candidate.
    "superseded_at"               TIMESTAMPTZ(6),

    "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "opportunity_requirement_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_requirement_type_chk') THEN
        ALTER TABLE "opportunity_requirement"
            ADD CONSTRAINT "opportunity_requirement_type_chk"
            CHECK ("requirement_type" IN (
                'technical',
                'deliverable',
                'evaluation',
                'past_performance',
                'clearance_security',
                'vehicle',
                'certification',
                'place_of_performance',
                'submission',
                'question_deadline',
                'key_date'
            ));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_requirement_confidence_chk') THEN
        ALTER TABLE "opportunity_requirement"
            ADD CONSTRAINT "opportunity_requirement_confidence_chk"
            CHECK ("confidence" IN ('high', 'medium', 'low'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_requirement_method_chk') THEN
        ALTER TABLE "opportunity_requirement"
            ADD CONSTRAINT "opportunity_requirement_method_chk"
            CHECK ("extraction_method" IN ('model', 'deterministic_pattern', 'human'));
    END IF;
END $$;

-- The span must be internally coherent, and the excerpt must MATCH it. An
-- excerpt longer than the range it claims to come from is a paraphrase wearing
-- a citation.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_requirement_span_chk') THEN
        ALTER TABLE "opportunity_requirement"
            ADD CONSTRAINT "opportunity_requirement_span_chk"
            CHECK (
                "excerpt_start" >= 0
                AND "excerpt_end" > "excerpt_start"
                AND length("source_excerpt") = "excerpt_end" - "excerpt_start"
            );
    END IF;
END $$;

-- An empty excerpt is not evidence, and a bounded one keeps a "quote" from
-- becoming a copy of the document.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_requirement_excerpt_chk') THEN
        ALTER TABLE "opportunity_requirement"
            ADD CONSTRAINT "opportunity_requirement_excerpt_chk"
            CHECK (length("source_excerpt") BETWEEN 1 AND 2000);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_requirement_hash_chk') THEN
        ALTER TABLE "opportunity_requirement"
            ADD CONSTRAINT "opportunity_requirement_hash_chk"
            CHECK ("attachment_content_sha256" ~ '^[0-9a-f]{64}$');
    END IF;
END $$;

-- One row per (document version, type, span). Re-extracting the SAME bytes is
-- therefore idempotent — the acceptance line — and a genuinely different span
-- is a different requirement.
CREATE UNIQUE INDEX IF NOT EXISTS "opportunity_requirement_evidence_uniq"
    ON "opportunity_requirement" (
        "attachment_content_sha256",
        "requirement_type",
        "excerpt_start",
        "excerpt_end"
    );

CREATE INDEX IF NOT EXISTS "opportunity_requirement_sam_idx"
    ON "opportunity_requirement" ("sam_opportunity_id", "requirement_type");

CREATE INDEX IF NOT EXISTS "opportunity_requirement_binding_idx"
    ON "opportunity_requirement" ("attachment_content_sha256", "superseded_at");

-- ─────────────────────────────────────────────────────────────────────────────
-- The REVIEW. Tenant-scoped, because a decision belongs to one team.

CREATE TABLE IF NOT EXISTS "opportunity_requirement_review" (
    "id"              UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id"       UUID NOT NULL,
    "requirement_id"  UUID NOT NULL,

    "status"          TEXT NOT NULL,
    -- All-or-nothing with `status`, enforced below: a decision nobody can be
    -- attributed to is a decision nobody can be asked about later. Same shape
    -- as client_funding_opportunity_decision_actor_chk (P07).
    "reviewed_by"     UUID,
    "reviewed_at"     TIMESTAMPTZ(6),
    "review_notes"    TEXT,

    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "opportunity_requirement_review_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_requirement_review_status_chk') THEN
        ALTER TABLE "opportunity_requirement_review"
            ADD CONSTRAINT "opportunity_requirement_review_status_chk"
            CHECK ("status" IN ('pending', 'accepted', 'rejected'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_requirement_review_actor_chk') THEN
        ALTER TABLE "opportunity_requirement_review"
            ADD CONSTRAINT "opportunity_requirement_review_actor_chk"
            CHECK (
                ("status" = 'pending' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL)
                OR ("status" <> 'pending' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
            );
    END IF;
END $$;

-- One review per (tenant, requirement). A second opinion replaces the first
-- through an audited update, never by accumulating rows nothing can order.
CREATE UNIQUE INDEX IF NOT EXISTS "opportunity_requirement_review_tenant_req_uniq"
    ON "opportunity_requirement_review" ("tenant_id", "requirement_id");

CREATE INDEX IF NOT EXISTS "opportunity_requirement_review_status_idx"
    ON "opportunity_requirement_review" ("tenant_id", "status");

-- Tenant-scoped, so RLS ENABLED + FORCED with the standard four policies.
-- FORCED matters: enabled-but-not-forced leaves the table owner exempt, and
-- migrations run as the owner.
ALTER TABLE "opportunity_requirement_review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opportunity_requirement_review" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'opportunity_requirement_review' AND policyname = 'opportunity_requirement_review_select'
  ) THEN
    CREATE POLICY "opportunity_requirement_review_select" ON "opportunity_requirement_review"
        FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'opportunity_requirement_review' AND policyname = 'opportunity_requirement_review_insert'
  ) THEN
    CREATE POLICY "opportunity_requirement_review_insert" ON "opportunity_requirement_review"
        FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'opportunity_requirement_review' AND policyname = 'opportunity_requirement_review_update'
  ) THEN
    CREATE POLICY "opportunity_requirement_review_update" ON "opportunity_requirement_review"
        FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
        WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'opportunity_requirement_review' AND policyname = 'opportunity_requirement_review_delete'
  ) THEN
    CREATE POLICY "opportunity_requirement_review_delete" ON "opportunity_requirement_review"
        FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END $$;
