-- Funding Opportunities P28 — normalized notice history.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- One table: `tango_opportunity_notice`. Each row is ONE observation of one
-- notice in an opportunity's history — the amendments, the presolicitation it
-- started as, the cancellation. The material-change TIMELINE is derived from
-- these rows at read time by `opportunity-change-classifier.ts`; it is not
-- stored, because a derived timeline stored alongside its inputs is a second
-- thing that can be wrong about them.
--
-- WHY A DEDICATED TABLE AND NOT tango_resource_snapshot
-- -------------------------------------------------------------------
-- P15's snapshot store is keyed (resource_type, external_id) with a single
-- ACTIVE version per resource — the right shape for "the current state of this
-- entity, plus an audit trail". A notice history is the opposite access
-- pattern: the query is always "every notice under THIS opportunity, in
-- order", which a snapshot table cannot answer without scanning its JSON.
-- Hence real columns for the ordering keys and the compared facts, plus
-- `snapshot` for the full normalized observation.
--
-- WHY GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- Same reasoning as `sam_opportunity`, `tango_resource_snapshot` (P15) and
-- `tango_opportunity_parity` (P27): "this solicitation's deadline moved on
-- 14 July" is a fact about the federal marketplace, not about any one tenant.
--
-- WHY NO FOREIGN KEY
-- -------------------------------------------------------------------
-- `sam_opportunity_id` is a SOFT pointer, matching `tango_resource_link` and
-- `tango_opportunity_parity`. The history of a notice must outlive either
-- catalog's own row lifecycle; a cascade would delete the record that an
-- amendment ever happened.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "tango_opportunity_notice" (
    "id"                    UUID NOT NULL DEFAULT uuid_generate_v4(),

    -- The provider's own notice id. The upsert key: one row per notice, ever.
    "tango_notice_id"       TEXT NOT NULL,
    -- The opportunity this notice belongs to, when the sync knows it. Nullable
    -- because a notice can be observed through a solicitation-number query
    -- before its parent opportunity has been walked.
    "tango_opportunity_id"  TEXT,
    -- `sam_opportunity.id`, when P27's crosswalk resolved the parent. Soft
    -- pointer, no FK.
    "sam_opportunity_id"    UUID,

    "solicitation_number"   TEXT,
    "title"                 TEXT,

    -- The ordering keys. `posted_date` is the notice's own; `provider_updated_at`
    -- is the provider's last-touched stamp, used as the tiebreaker so two
    -- notices posted the same day still order deterministically.
    "posted_date"           TIMESTAMPTZ(6),
    "provider_updated_at"   TIMESTAMPTZ(6),

    -- The compared facts. Every one is a real column rather than a JSON path,
    -- because the change classifier reads them on every timeline request.
    "response_deadline"     TIMESTAMPTZ(6),
    "active"                BOOLEAN,
    "set_aside"             TEXT,
    "naics_code"            TEXT,
    "psc_code"              TEXT,
    "attachment_count"      INTEGER,

    "source_url"            TEXT,

    -- Canonical SHA-256 over the normalized observation. A re-sync with
    -- identical content is a no-op: same hash, no new observation, and
    -- therefore no material change in the derived timeline.
    "content_hash"          TEXT NOT NULL,
    "snapshot"              JSONB NOT NULL,

    "first_synced_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_synced_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tango_opportunity_notice_pkey" PRIMARY KEY ("id")
);

-- Lowercase hex, 64 characters. Same guard tango_resource_snapshot_hash_chk
-- (P15) carries, and for the same reason: a truncated or differently-cased
-- hash silently defeats the no-op check that makes a re-sync free.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tango_opportunity_notice_hash_chk'
    ) THEN
        ALTER TABLE "tango_opportunity_notice"
            ADD CONSTRAINT "tango_opportunity_notice_hash_chk"
            CHECK ("content_hash" ~ '^[0-9a-f]{64}$');
    END IF;
END $$;

-- A negative attachment count is not a smaller number of attachments; it is a
-- mapping bug. Refused rather than stored and later rendered.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tango_opportunity_notice_attachment_count_chk'
    ) THEN
        ALTER TABLE "tango_opportunity_notice"
            ADD CONSTRAINT "tango_opportunity_notice_attachment_count_chk"
            CHECK ("attachment_count" IS NULL OR "attachment_count" >= 0);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tango_opportunity_notice_notice_id_uniq"
    ON "tango_opportunity_notice" ("tango_notice_id");

-- THE timeline query: every notice under one opportunity, in posting order.
CREATE INDEX IF NOT EXISTS "tango_opportunity_notice_parent_idx"
    ON "tango_opportunity_notice" ("tango_opportunity_id", "posted_date");

-- The same question asked from the local side, which is how the UI reaches it.
CREATE INDEX IF NOT EXISTS "tango_opportunity_notice_sam_idx"
    ON "tango_opportunity_notice" ("sam_opportunity_id", "posted_date");
