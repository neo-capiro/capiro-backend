-- Funding Opportunities P27 — Tango↔SAM crosswalk and parity ledger.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- One table: `tango_opportunity_parity`. It records, per FIELD, whether
-- Capiro's first-party SAM.gov row and MakeGov/Tango's own observation of
-- the same opportunity AGREE — and, when they do not, what each side says.
--
-- WHAT THIS DELIBERATELY IS NOT
-- -------------------------------------------------------------------
-- It is NOT a merge, and it never writes to `sam_opportunity`. §4.2 of the
-- plan is explicit and this phase is where it binds:
--
--   1. Existing first-party Capiro ingestion remains AUTHORITATIVE for
--      canonical lifecycle fields.
--   2. Tango observations may verify, enrich, or identify conflicts.
--   3. A conflict is RECORDED; no source silently overwrites the other.
--   4. No "last write wins" merge is permitted.
--
-- A ledger row is therefore evidence, not a decision. `resolution` starts at
-- 'unreviewed' and the local value stays canonical until a human says
-- otherwise — there is no code path in this phase that changes a
-- `sam_opportunity` column, and `sync-tango-opportunity-shadow.ts` has a
-- structural test proving it.
--
-- WHY THERE IS NO SECOND LINK TABLE
-- -------------------------------------------------------------------
-- P15 already built one. `tango_resource_link` links a LOCAL resource
-- (`sam_opportunity` is in its own CHECK-constrained vocabulary) to a Tango
-- resource (`opportunity` is in `TANGO_RESOURCE_TYPES`), with a basis
-- restricted to `exact_identifier` | `reviewed_manual` — no fuzzy value
-- exists in that column and none is added here. Building a parallel
-- `tango_sam_crosswalk` table would have meant two answers to "is this
-- linked", which is exactly the drift P01 removed for profiles. The link
-- lives in P15's table; only the PER-FIELD ledger is new.
--
-- Likewise the provider's own observation of an opportunity goes to P15's
-- versioned `tango_resource_snapshot`, not to a third table. That is the
-- opposite of P24's forecast decision (decision-log D-46) and for a stated
-- reason: a forecast is a 24,000-row high-volume catalog Capiro tracks the
-- CURRENT state of, while a shadow-synced opportunity is a bounded,
-- conflict-bearing record whose HISTORY is the point — if the provider's
-- stated deadline moves, the previous observation is the evidence that it
-- moved.
--
-- WHY GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- Same reasoning as `tango_resource_snapshot` (P15), `sam_opportunity` and
-- `federal_grant`: "the provider and SAM.gov disagree about this notice's
-- deadline" is a fact about the federal marketplace, not about any one
-- tenant. Omitting tenant_id is what keeps a plain
-- `this.prisma.tangoOpportunityParity.*` call correctly UNFLAGGED by
-- tenant-scope-guard.spec.ts.
--
-- WHY NO FOREIGN KEY TO sam_opportunity
-- -------------------------------------------------------------------
-- `sam_opportunity_id` is a SOFT pointer, matching `tango_resource_link`'s
-- own `local_resource_id`. This ledger is an observation about two
-- independently-synced catalogs; a cascade from either side would delete the
-- evidence that they ever disagreed, which is the one thing the table exists
-- to keep. An orphaned row is readable and reportable; a deleted one is not.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS, so a half-applied run can be
-- re-applied cleanly. A failed migration blocks every later one.

CREATE TABLE IF NOT EXISTS "tango_opportunity_parity" (
    "id"                    UUID NOT NULL DEFAULT uuid_generate_v4(),

    -- The provider's own opportunity id. Also the `tango_external_id` of the
    -- matching `tango_resource_link` row and of the `tango_resource_snapshot`
    -- observation this comparison was computed from.
    "tango_opportunity_id"  TEXT NOT NULL,
    -- `sam_opportunity.id`. Soft pointer — see this file's own header.
    "sam_opportunity_id"    UUID NOT NULL,

    -- Which lifecycle fact this row compares. Bounded by CHECK below.
    "field"                 TEXT NOT NULL,

    -- Both sides, as TEXT, verbatim from whichever column/field they came
    -- from. TEXT rather than a typed column per field because the ledger is
    -- one row per (record, field) and the fields are of different types; the
    -- comparison itself happens in the mapper, against typed values, before
    -- either side is stringified for storage. NULL means the side stated
    -- nothing — never zero, never false, never "no".
    "local_value"           TEXT,
    "provider_value"        TEXT,

    -- The comparison outcome. Five values, not two, because "they disagree"
    -- and "only one of them said anything" are different findings and only
    -- the first is a conflict a human needs to look at.
    "agreement"             TEXT NOT NULL,

    -- What was done about a conflict. Starts 'unreviewed'; 'local_canonical'
    -- is the DEFAULT resolution the source-precedence rule already implies
    -- (first-party wins) and is recorded explicitly rather than left implied,
    -- so "nobody has looked" stays distinguishable from "somebody looked and
    -- kept ours".
    "resolution"            TEXT NOT NULL DEFAULT 'unreviewed',
    "reviewed_by"           UUID,
    "reviewed_at"           TIMESTAMPTZ(6),
    "review_notes"          TEXT,

    -- When this (record, field) comparison was FIRST observed with its current
    -- outcome, and when it was last confirmed. A conflict that has stood for
    -- three weeks reads differently from one that appeared this morning.
    "first_observed_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_observed_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tango_opportunity_parity_pkey" PRIMARY KEY ("id")
);

-- The bounded field vocabulary. Only LIFECYCLE facts both catalogs actually
-- carry: a field only one side has is provider-exclusive enrichment and
-- belongs in the snapshot, not in a comparison that would report every row as
-- a conflict.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tango_opportunity_parity_field_chk'
    ) THEN
        ALTER TABLE "tango_opportunity_parity"
            ADD CONSTRAINT "tango_opportunity_parity_field_chk"
            CHECK ("field" IN (
                'title',
                'solicitation_number',
                'response_deadline',
                'active',
                'set_aside',
                'naics_code',
                'psc_code',
                'agency'
            ));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tango_opportunity_parity_agreement_chk'
    ) THEN
        ALTER TABLE "tango_opportunity_parity"
            ADD CONSTRAINT "tango_opportunity_parity_agreement_chk"
            CHECK ("agreement" IN (
                'agree',
                'conflict',
                'local_only',
                'provider_only',
                'both_absent'
            ));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tango_opportunity_parity_resolution_chk'
    ) THEN
        ALTER TABLE "tango_opportunity_parity"
            ADD CONSTRAINT "tango_opportunity_parity_resolution_chk"
            CHECK ("resolution" IN (
                'unreviewed',
                'local_canonical',
                'accepted_provider',
                'dismissed'
            ));
    END IF;
END $$;

-- A REVIEWED resolution must carry who and when — the same three-way
-- all-or-nothing shape client_funding_opportunity_decision_actor_chk (P07)
-- enforces for a human decision, and for the same reason: a resolution
-- nobody can be attributed to is a resolution nobody can be asked about
-- later. 'unreviewed' must carry NEITHER, so a reviewed row cannot be walked
-- back to unreviewed while keeping the actor.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tango_opportunity_parity_review_actor_chk'
    ) THEN
        ALTER TABLE "tango_opportunity_parity"
            ADD CONSTRAINT "tango_opportunity_parity_review_actor_chk"
            CHECK (
                ("resolution" = 'unreviewed' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL)
                OR ("resolution" <> 'unreviewed' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
            );
    END IF;
END $$;

-- One row per (provider opportunity, local opportunity, field), ever. This is
-- what makes a re-run an UPDATE of the same comparison rather than a second
-- opinion about it — the idempotency this phase's acceptance bar requires.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_opportunity_parity_record_field_uniq"
    ON "tango_opportunity_parity" ("tango_opportunity_id", "sam_opportunity_id", "field");

-- The diagnostic's own query shape: "every unreviewed conflict, newest first".
CREATE INDEX IF NOT EXISTS "tango_opportunity_parity_conflict_idx"
    ON "tango_opportunity_parity" ("agreement", "resolution", "last_observed_at");

-- "Show me everything known about this SAM notice", from the local side.
CREATE INDEX IF NOT EXISTS "tango_opportunity_parity_sam_idx"
    ON "tango_opportunity_parity" ("sam_opportunity_id");
