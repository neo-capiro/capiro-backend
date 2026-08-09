-- Funding Opportunities P42 — SBIR/STTR schema.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- Innovation topics and their parent solicitation cycles as their own source.
-- A TOPIC is the unit a small business responds to; a SOLICITATION is the cycle
-- the topic sits in. The provider serves them from two list endpoints,
-- /api/sbir/topics/ and /api/sbir/solicitations/, transcribed in
-- dibbs-sbir-rest-contract.md.
--
-- WHY THESE TABLES ARE GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- An SBIR topic is a fact about the FEDERAL MARKETPLACE, not about any one
-- tenant — the same reasoning tango_dibbs_solicitation (P40),
-- tango_procurement_forecast (P24) and sam_opportunity (P00) already carry.
-- Tenant-scoped MATCHING against these rows is P43's problem and lands in its
-- own table.
--
-- WHY TWO TABLES, AND WHY NO FOREIGN KEY BETWEEN THEM
-- -------------------------------------------------------------------
-- Topics and cycles are different things with different identities and
-- different lifecycles: a cycle carries dates and a program, a topic carries an
-- agency and its own open/close window. They are joined on
-- `solicitation_number`, which is the only key a topic carries back to its
-- parent.
--
-- That join is UNENFORCED, deliberately. A topic can name a cycle this system
-- never synced — a different date window, a different filter, or simply not
-- fetched yet — and a FK would make a missing parent silently drop a real
-- topic. Identical decision, for identical reasons, to
-- tango_dibbs_award.solicitation (P40).
--
-- SBIR AND STTR SHARE A TABLE
-- -------------------------------------------------------------------
-- `program` discriminates them. Every other field means the same thing for
-- both, and the provider serves both from one endpoint — so two tables would
-- duplicate a schema to record one string. Note the column carries NO CHECK:
-- the contract documents the field, not its value set, and a vocabulary
-- invented here would reject a real value on first contact. This is the
-- opposite call from tango_dibbs_solicitation.document_type, where the
-- documentation DOES enumerate exactly two endpoints and therefore two values.
--
-- WHAT P42's PLAN ASKS FOR THAT THE PROVIDER DOES NOT PUBLISH
-- -------------------------------------------------------------------
-- The phase's work item names "topic, agency/component, solicitation cycle,
-- phase, open/close dates, description, source opportunity/grant link, and DSIP
-- parent". FOUR of those have no documented field on either endpoint:
--
--   * PHASE (I/II/III) — a real SBIR concept, absent from the published field
--     list. There is deliberately NO COLUMN for it. An always-null column reads
--     as "we hold this and it is empty", which is a different and worse claim
--     than "the source does not state it".
--   * DESCRIPTION — not published on the list resource.
--   * DSIP PARENT — `official_solicitation_url` may point at DSIP, but a URL is
--     not a parent key and must not be parsed into one.
--   * SOURCE OPPORTUNITY / GRANT LINK — no crosswalk field exists on this
--     resource. P27's Tango-SAM crosswalk is a separate, evidence-backed
--     mechanism and is not something to approximate here.
--
-- Recorded rather than solved, so the next reader does not add a column and
-- populate it from something adjacent. That is the
-- AwardHistoryFacts.contractOffices mistake, which fed an office signal the
-- awarding sub-tier because it happened to be nearby.
--
-- If a later phase confirms these fields exist on the DETAIL endpoints
-- (/api/sbir/topics/{topic_id}/), that is a contract-doc update and a new
-- migration — not an inference from the list resource.
--
-- NO SOURCE-CHECK WIDENING IS NEEDED, AND THAT WAS VERIFIED, NOT ASSUMED
-- -------------------------------------------------------------------
-- `client_funding_opportunity_source_chk` has admitted 'sbir_sttr' since P13's
-- generic identity bridge (20260820010000_funding_opportunity_generic_source),
-- which widened the vocabulary specifically so the generic branch would be
-- reachable and testable. `SOURCE_RECORD_TYPES.sbir_sttr` is already
-- 'sbir_topic'. Confirmed by reading that migration file — the same check P41
-- part 2 made for 'dibbs', and the OPPOSITE of D-63's
-- tango_sync_checkpoint.resource_type, which really never was widened. The two
-- situations are indistinguishable from a distance; read the migration.
--
-- UNCONFIRMED AGAINST A LIVE RESPONSE
-- -------------------------------------------------------------------
-- NOTHING HAS EVER CALLED /api/sbir/. P17's 2026-08-08 run confirmed the
-- pagination envelope for /api/dibbs/ only. Every column below is a
-- conservative reading of a published field NAME: text for anything that could
-- be an identifier carrying leading zeros, date for dates, integer only for
-- `year`. Confirm against one real response before trusting any type here, and
-- expect at least one to be wrong.

-- ── Solicitation cycles ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tango_sbir_solicitation" (
  "id"                  UUID NOT NULL DEFAULT uuid_generate_v4(),

  -- The provider's own `solicitation_id`. NOT a uuid: the contract records that
  -- topics key on `topic_id` and solicitations on `solicitation_id`, neither of
  -- which is the `uuid` DIBBS uses.
  "tango_sbir_id"       TEXT NOT NULL,

  -- The only key a topic carries back to its cycle. NOT NULL: a cycle nothing
  -- can join to is not usable, and the mapper drops such a record rather than
  -- storing it unreachable.
  "solicitation_number" TEXT NOT NULL,
  "title"               TEXT,

  -- 'SBIR' | 'STTR' as the provider spells it. No CHECK — see the header.
  "program"             TEXT,

  "cycle_name"          TEXT,
  "year"                INTEGER,

  "start_date"          DATE,
  "end_date"            DATE,

  "out_of_cycle"        BOOLEAN,

  "activity"            TEXT,
  -- The provider's own lifecycle word, as stated. Never derived from end_date.
  "solicitation_status" TEXT,

  "sol_download_url"    TEXT,

  "first_synced_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_synced_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "tango_sbir_solicitation_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_solicitation_id_chk'
  ) THEN
    ALTER TABLE "tango_sbir_solicitation"
      ADD CONSTRAINT "tango_sbir_solicitation_id_chk"
      CHECK (btrim("tango_sbir_id") <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_solicitation_number_chk'
  ) THEN
    ALTER TABLE "tango_sbir_solicitation"
      ADD CONSTRAINT "tango_sbir_solicitation_number_chk"
      CHECK (btrim("solicitation_number") <> '');
  END IF;

  -- A four-digit fiscal/solicitation year. Bounded loosely on purpose: the
  -- point is to refuse a parsed timestamp or a two-digit year that would sort
  -- and filter wrongly, not to predict how long this program runs.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_solicitation_year_chk'
  ) THEN
    ALTER TABLE "tango_sbir_solicitation"
      ADD CONSTRAINT "tango_sbir_solicitation_year_chk"
      CHECK ("year" IS NULL OR ("year" BETWEEN 1980 AND 2200));
  END IF;

  -- A cycle that ends before it starts is a mapping error, not a real cycle.
  -- Both nullable, so this only fires when the provider stated both.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_solicitation_dates_chk'
  ) THEN
    ALTER TABLE "tango_sbir_solicitation"
      ADD CONSTRAINT "tango_sbir_solicitation_dates_chk"
      CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tango_sbir_solicitation_tango_id_uniq"
  ON "tango_sbir_solicitation" ("tango_sbir_id");

CREATE INDEX IF NOT EXISTS "tango_sbir_solicitation_number_idx"
  ON "tango_sbir_solicitation" ("solicitation_number");
CREATE INDEX IF NOT EXISTS "tango_sbir_solicitation_program_idx"
  ON "tango_sbir_solicitation" ("program");
CREATE INDEX IF NOT EXISTS "tango_sbir_solicitation_year_idx"
  ON "tango_sbir_solicitation" ("year");
CREATE INDEX IF NOT EXISTS "tango_sbir_solicitation_status_idx"
  ON "tango_sbir_solicitation" ("solicitation_status");

COMMENT ON TABLE "tango_sbir_solicitation" IS
  'P42. SBIR/STTR solicitation cycles. Global, no tenant_id by design. Topics join on solicitation_number, unenforced.';
COMMENT ON COLUMN "tango_sbir_solicitation"."program" IS
  'SBIR vs STTR, as the provider spells it. Deliberately unconstrained: the contract documents the field, not its value set.';
COMMENT ON COLUMN "tango_sbir_solicitation"."solicitation_status" IS
  'The provider''s own lifecycle word, as stated. Never derived from end_date.';

-- ── Topics ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tango_sbir_topic" (
  "id"                        UUID NOT NULL DEFAULT uuid_generate_v4(),

  -- The provider's own `topic_id` — a DIFFERENT field name from the sibling
  -- table's `solicitation_id`. Do not assume a shared identity column.
  "tango_sbir_id"             TEXT NOT NULL,

  -- The public topic number a human cites, distinct from the provider's row id.
  "topic_number"              TEXT,
  "title"                     TEXT,

  -- The provider's single `agency` field. There is no separate component field
  -- on this resource, so nothing is split into one.
  "agency"                    TEXT,
  "year"                      INTEGER,

  -- The parent cycle, as stated and unenforced. See the header.
  "solicitation_number"       TEXT,

  "release_date"              DATE,
  "open_date"                 DATE,
  "close_date"                DATE,

  "activity"                  TEXT,
  -- A closed topic is still stored. P42's acceptance is that it stays
  -- REFERENCE-ONLY, which is a rule about what may pursue it (P43), not a
  -- reason to drop the row.
  "solicitation_status"       TEXT,

  "topic_url"                 TEXT,
  "official_solicitation_url" TEXT,

  "first_synced_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_synced_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "tango_sbir_topic_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_topic_id_chk'
  ) THEN
    ALTER TABLE "tango_sbir_topic"
      ADD CONSTRAINT "tango_sbir_topic_id_chk"
      CHECK (btrim("tango_sbir_id") <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_topic_year_chk'
  ) THEN
    ALTER TABLE "tango_sbir_topic"
      ADD CONSTRAINT "tango_sbir_topic_year_chk"
      CHECK ("year" IS NULL OR ("year" BETWEEN 1980 AND 2200));
  END IF;

  -- A topic that closes before it opens is a mapping error. `release_date` is
  -- deliberately NOT part of this: a topic can be released long before it
  -- opens, and ordering release against open would refuse a real row.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_topic_dates_chk'
  ) THEN
    ALTER TABLE "tango_sbir_topic"
      ADD CONSTRAINT "tango_sbir_topic_dates_chk"
      CHECK ("open_date" IS NULL OR "close_date" IS NULL OR "close_date" >= "open_date");
  END IF;

  -- An empty string is not a solicitation number. NULL means the provider
  -- stated no parent; '' would join to nothing while looking like a value.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_sbir_topic_parent_chk'
  ) THEN
    ALTER TABLE "tango_sbir_topic"
      ADD CONSTRAINT "tango_sbir_topic_parent_chk"
      CHECK ("solicitation_number" IS NULL OR btrim("solicitation_number") <> '');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tango_sbir_topic_tango_id_uniq"
  ON "tango_sbir_topic" ("tango_sbir_id");

CREATE INDEX IF NOT EXISTS "tango_sbir_topic_solicitation_number_idx"
  ON "tango_sbir_topic" ("solicitation_number");
CREATE INDEX IF NOT EXISTS "tango_sbir_topic_topic_number_idx"
  ON "tango_sbir_topic" ("topic_number");
CREATE INDEX IF NOT EXISTS "tango_sbir_topic_agency_idx"
  ON "tango_sbir_topic" ("agency");
CREATE INDEX IF NOT EXISTS "tango_sbir_topic_close_date_idx"
  ON "tango_sbir_topic" ("close_date");

COMMENT ON TABLE "tango_sbir_topic" IS
  'P42. SBIR/STTR topics. Global, no tenant_id by design. Joins to tango_sbir_solicitation on solicitation_number, UNENFORCED - a topic may name a cycle never synced.';
COMMENT ON COLUMN "tango_sbir_topic"."tango_sbir_id" IS
  'The provider''s topic_id. A DIFFERENT field from the sibling table''s solicitation_id - these APIs share no identity column.';
COMMENT ON COLUMN "tango_sbir_topic"."solicitation_status" IS
  'The parent cycle''s status as stated by the provider. A closed topic is still stored; reference-only is a rule about pursuit (P43), not about storage.';
