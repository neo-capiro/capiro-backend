-- Funding Opportunities — correcting a P28 defect.
--
-- WHAT WAS WRONG
-- -------------------------------------------------------------------
-- P28's change classifier declared "description" one of four dimensions the
-- provider does not supply. It does supply one: the SDK's own `NOTICE_SCHEMA`
-- declares `description` as a plain optional `str`. The mistake was reading
-- `TangoNotice` — whose field list had omitted it — instead of the schema.
--
-- The consequence was not cosmetic. A solicitation whose body text was
-- rewritten between two notices produced a timeline entry with no changes on
-- it, and the panel said so in as many words, while telling the reader that
-- description changes could not be observed at all. Both statements were
-- false.
--
-- WHAT THIS ADDS
-- -------------------------------------------------------------------
-- Two columns on `tango_opportunity_notice`, both nullable and both additive:
--
--   `description`        the notice body, verbatim. Untrusted source text.
--   `description_sha256` SHA-256 of the normalized body, or NULL when the
--                        provider stated none.
--
-- The classifier compares the HASH, never the bodies. A description runs to
-- tens of kilobytes and the timeline query fetches up to 500 notices; loading
-- every body to compare two adjacent ones would make a detail page read
-- megabytes to answer "did the text change". The body itself is stored so a
-- later phase (P30/P31's requirement extraction) has it without re-fetching,
-- but nothing on the timeline path selects it.
--
-- NULLABLE, deliberately. Every row written before this migration has no
-- description and no hash, and that is the honest state for them: "we did not
-- request this field when we observed this notice" is different from "the
-- provider stated none". A backfill would need to re-observe every notice,
-- which the next incremental sync does anyway.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS.

ALTER TABLE "tango_opportunity_notice"
    ADD COLUMN IF NOT EXISTS "description" TEXT;

ALTER TABLE "tango_opportunity_notice"
    ADD COLUMN IF NOT EXISTS "description_sha256" TEXT;

-- Lowercase hex, 64 characters, same guard as `content_hash` and for the same
-- reason: a truncated or differently-cased hash would compare unequal to an
-- identical body and report a phantom description change on every re-sync.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tango_opportunity_notice_description_hash_chk'
    ) THEN
        ALTER TABLE "tango_opportunity_notice"
            ADD CONSTRAINT "tango_opportunity_notice_description_hash_chk"
            CHECK ("description_sha256" IS NULL OR "description_sha256" ~ '^[0-9a-f]{64}$');
    END IF;
END $$;

-- A hash with no body, or a body with no hash, is a half-written row. Both
-- present or both absent — the same all-or-nothing discipline the review-actor
-- and decision-actor CHECKs elsewhere in this program use.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tango_opportunity_notice_description_pair_chk'
    ) THEN
        ALTER TABLE "tango_opportunity_notice"
            ADD CONSTRAINT "tango_opportunity_notice_description_pair_chk"
            CHECK (
                ("description" IS NULL AND "description_sha256" IS NULL)
                OR ("description" IS NOT NULL AND "description_sha256" IS NOT NULL)
            );
    END IF;
END $$;
