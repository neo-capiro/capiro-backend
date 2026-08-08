-- Funding Opportunities P40 — DLA bid-board (DIBBS) schema.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- DLA's bid board as its own defense source: RFQs, RFP/IFBs, and awards,
-- at LINE-ITEM grain. A DIBBS row is a solicitation for one NSN/part, not a
-- contract — the distinction drives most of the decisions below.
--
-- WHY THESE TABLES ARE GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- A DLA solicitation is a fact about the FEDERAL MARKETPLACE, not about any
-- one tenant — the same reasoning tango_procurement_forecast (P24),
-- tango_resource_snapshot (P15) and sam_opportunity (P00) already carry.
-- Omitting tenant_id here is deliberate and consistent, not an oversight:
-- there is no per-tenant fact in a bid-board posting. Tenant-scoped MATCHING
-- against these rows is P41's problem and lands in its own table.
--
-- WHY RFQs AND RFPs SHARE ONE TABLE BUT AWARDS DO NOT
-- -------------------------------------------------------------------
-- RFQ and RFP/IFB are the same thing to a pursuer — a biddable bid-board item
-- keyed by solicitation + NSN + part — so they share a table with a
-- `document_type` discriminator. The provider splits them across two
-- endpoints and spells two fields differently for the same concept
-- (issue_date/issued_date, return_by_date/closes_date); the mapper normalizes
-- that, and the column names record the concept rather than either spelling.
--
-- Awards are a SEPARATE TABLE because P40's acceptance requires that award
-- rows "are informational and cannot be pursued". A boolean column would
-- satisfy that only while every future query remembered to filter on it. A
-- separate table makes it structural: an award cannot reach a pursuable
-- surface through a forgotten predicate, because it is not in the table those
-- surfaces read.
--
-- WHY THERE IS NO FOREIGN KEY FROM AWARD TO SOLICITATION
-- -------------------------------------------------------------------
-- An award can name a solicitation this system never synced (different date
-- window, different filter, or simply not yet fetched). A FK would make a
-- missing parent silently drop a real award. The solicitation number is
-- stored as stated, unenforced.
--
-- MONEY AND QUANTITY
-- -------------------------------------------------------------------
-- NUMERIC, never a float. Both nullable, and the nullability is meaningful:
-- a null quantity is "the provider stated none", not zero. `unit_of_issue`
-- and `quantity` are independently nullable and neither is inferred from the
-- other — a quantity without its unit cannot be interpreted, so a mapper
-- that invented "EA" would be inventing the fact, not defaulting a format.
--
-- total_contract_price MUST NEVER BE SUMMED ACROSS ROWS. delivery_order_number
-- and delivery_order_counter mean one contract appears as many rows, so a SUM
-- double-counts by construction. The provider's published contract defines no
-- safe aggregation, and P40 explicitly prohibits inventing one.
--
-- UNCONFIRMED AGAINST A LIVE RESPONSE
-- -------------------------------------------------------------------
-- Every column here is derived from the PUBLISHED FIELD LIST at
-- docs.makegov.com (transcribed in dibbs-sbir-rest-contract.md). The docs give
-- field NAMES; they do not give types, null semantics, date formats, or the
-- pagination envelope. Types below are the conservative reading (text for
-- anything that could be an identifier with leading zeros — NSNs and CAGE
-- codes both can be; numeric for money and quantity; date for dates). No live
-- call has been made — no key was available, and per plan §4.6 a key must
-- never pass through an agent session. Confirm against one real response
-- before trusting any inferred type.

-- ── RFQ / RFP ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tango_dibbs_solicitation" (
  "id"                     UUID NOT NULL DEFAULT uuid_generate_v4(),

  -- The provider's own row uuid. Upsert key, and what keeps duplicate line
  -- items distinct: two rows sharing a solicitation and NSN are still two
  -- rows if the provider issued two uuids.
  "tango_dibbs_id"         TEXT NOT NULL,

  "document_type"          TEXT NOT NULL,

  "solicitation"           TEXT NOT NULL,
  "solicitation_formatted" TEXT,
  "purchase_request"       TEXT,

  -- TEXT, not a number: an NSN is a 13-character identifier that can carry
  -- leading zeros, and a part number is not numeric at all.
  "nsn"                    TEXT,
  "part_number"            TEXT,
  "nomenclature"           TEXT,

  "quantity"               NUMERIC(18, 4),
  "unit_of_issue"          TEXT,

  "set_aside"              TEXT,
  "status_code"            TEXT,
  "buyer_code"             TEXT,

  -- Normalized: RFQ states issue_date/return_by_date, RFP states
  -- issued_date/closes_date.
  "issued_date"            DATE,
  "closes_date"            DATE,

  -- The provider's own judgement, kept as stated. NOT derived from
  -- closes_date — a past date does not always mean the provider closed it.
  "is_open"                BOOLEAN,

  "document_url"           TEXT,
  "tech_docs_url"          TEXT,

  "first_synced_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_synced_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "tango_dibbs_solicitation_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  -- Bounded vocabulary. Two values today; widening is a migration, not a
  -- surprise value arriving from the provider and being stored unnoticed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tango_dibbs_solicitation_document_type_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_solicitation"
      ADD CONSTRAINT "tango_dibbs_solicitation_document_type_chk"
      CHECK ("document_type" IN ('rfq', 'rfp'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tango_dibbs_solicitation_id_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_solicitation"
      ADD CONSTRAINT "tango_dibbs_solicitation_id_chk"
      CHECK (btrim("tango_dibbs_id") <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tango_dibbs_solicitation_solicitation_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_solicitation"
      ADD CONSTRAINT "tango_dibbs_solicitation_solicitation_chk"
      CHECK (btrim("solicitation") <> '');
  END IF;

  -- A quantity with no unit cannot be interpreted. Storing one would be
  -- storing a number nobody can act on; the mapper drops the pair instead.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tango_dibbs_solicitation_quantity_unit_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_solicitation"
      ADD CONSTRAINT "tango_dibbs_solicitation_quantity_unit_chk"
      CHECK ("quantity" IS NULL OR "unit_of_issue" IS NOT NULL);
  END IF;

  -- Negative quantities are not a thing the bid board publishes.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tango_dibbs_solicitation_quantity_sign_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_solicitation"
      ADD CONSTRAINT "tango_dibbs_solicitation_quantity_sign_chk"
      CHECK ("quantity" IS NULL OR "quantity" >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tango_dibbs_solicitation_tango_id_uniq"
  ON "tango_dibbs_solicitation" ("tango_dibbs_id");

CREATE INDEX IF NOT EXISTS "tango_dibbs_solicitation_solicitation_idx"
  ON "tango_dibbs_solicitation" ("solicitation");
CREATE INDEX IF NOT EXISTS "tango_dibbs_solicitation_nsn_idx"
  ON "tango_dibbs_solicitation" ("nsn");
CREATE INDEX IF NOT EXISTS "tango_dibbs_solicitation_part_number_idx"
  ON "tango_dibbs_solicitation" ("part_number");
CREATE INDEX IF NOT EXISTS "tango_dibbs_solicitation_type_closes_idx"
  ON "tango_dibbs_solicitation" ("document_type", "closes_date");

COMMENT ON TABLE "tango_dibbs_solicitation" IS
  'P40. DLA bid-board RFQs and RFP/IFBs at line-item grain. Global, no tenant_id by design. Awards live in tango_dibbs_award and are NOT pursuable.';
COMMENT ON COLUMN "tango_dibbs_solicitation"."is_open" IS
  'The provider''s own open/closed judgement, as stated. Never derived from closes_date.';
COMMENT ON COLUMN "tango_dibbs_solicitation"."quantity" IS
  'NULL means the provider stated none - never zero. Meaningless without unit_of_issue, which the quantity_unit check enforces.';

-- ── Awards ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tango_dibbs_award" (
  "id"                          UUID NOT NULL DEFAULT uuid_generate_v4(),

  "tango_dibbs_id"              TEXT NOT NULL,

  "award_number"                TEXT NOT NULL,
  "delivery_order_number"       TEXT,
  "delivery_order_counter"      INTEGER,

  -- Stated, not enforced. See the header: a missing parent must not drop a
  -- real award.
  "solicitation"                TEXT,
  "purchase_request"            TEXT,

  "nsn"                         TEXT,
  "part_number"                 TEXT,
  "nomenclature"                TEXT,

  "total_contract_price"        NUMERIC(18, 2),
  "total_contract_price_text"   TEXT,

  -- awardee_cage is the award's own top-level field; awardee_cage_code comes
  -- from the nested awardee object. The contract documents BOTH, so both are
  -- stored rather than one being assumed equal to the other.
  "awardee_cage"                TEXT,
  "awardee_uei"                 TEXT,
  "awardee_cage_code"           TEXT,
  "awardee_legal_business_name" TEXT,

  "award_date"                  DATE,
  "posted_date"                 DATE,
  "last_mod_posting_date"       DATE,

  "first_synced_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_synced_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "tango_dibbs_award_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_dibbs_award_id_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_award"
      ADD CONSTRAINT "tango_dibbs_award_id_chk"
      CHECK (btrim("tango_dibbs_id") <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_dibbs_award_number_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_award"
      ADD CONSTRAINT "tango_dibbs_award_number_chk"
      CHECK (btrim("award_number") <> '');
  END IF;

  -- Money is never negative on this source, and a zero-dollar award is a real
  -- thing (an IDIQ line with no funded value), so zero is allowed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_dibbs_award_price_sign_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_award"
      ADD CONSTRAINT "tango_dibbs_award_price_sign_chk"
      CHECK ("total_contract_price" IS NULL OR "total_contract_price" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_dibbs_award_do_counter_chk'
  ) THEN
    ALTER TABLE "tango_dibbs_award"
      ADD CONSTRAINT "tango_dibbs_award_do_counter_chk"
      CHECK ("delivery_order_counter" IS NULL OR "delivery_order_counter" >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tango_dibbs_award_tango_id_uniq"
  ON "tango_dibbs_award" ("tango_dibbs_id");

CREATE INDEX IF NOT EXISTS "tango_dibbs_award_award_number_idx"
  ON "tango_dibbs_award" ("award_number");
CREATE INDEX IF NOT EXISTS "tango_dibbs_award_solicitation_idx"
  ON "tango_dibbs_award" ("solicitation");
CREATE INDEX IF NOT EXISTS "tango_dibbs_award_nsn_idx"
  ON "tango_dibbs_award" ("nsn");
CREATE INDEX IF NOT EXISTS "tango_dibbs_award_awardee_cage_idx"
  ON "tango_dibbs_award" ("awardee_cage");
CREATE INDEX IF NOT EXISTS "tango_dibbs_award_posted_date_idx"
  ON "tango_dibbs_award" ("posted_date");

COMMENT ON TABLE "tango_dibbs_award" IS
  'P40. DIBBS awards - INFORMATIONAL ONLY, never pursuable. Separate table from tango_dibbs_solicitation so that cannot be forgotten in a predicate.';
COMMENT ON COLUMN "tango_dibbs_award"."total_contract_price" IS
  'NEVER SUM ACROSS ROWS. Line-item grain: delivery_order_number/counter mean one contract appears as many rows, so a SUM double-counts. The source defines no safe aggregation (P40).';
COMMENT ON COLUMN "tango_dibbs_award"."awardee_cage" IS
  'The award''s own top-level CAGE. Not assumed equal to awardee_cage_code from the nested awardee object - the contract documents both.';
