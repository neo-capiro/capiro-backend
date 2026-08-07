-- Funding Opportunities P45 — protest and exclusion risk context.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- Two provider-owned observations that a capture team should weigh before
-- committing to a pursuit: bid protests (GAO and the Court of Federal Claims)
-- and an entity's exclusion flag.
--
-- WHAT IT IS NOT
-- -------------------------------------------------------------------
-- Neither table holds a conclusion, and nothing derived from them is permitted
-- to state one.
--
--   * A PROTEST IS CONTEXT. That a related procurement was protested is not
--     evidence that this procurement is invalid, that the agency erred, or
--     that an award will be overturned. `outcome` holds the provider's own
--     word for what happened and is never re-phrased into a judgement — the
--     two forums use the same words for different things.
--   * AN EXCLUSION FLAG IS AN OBSERVATION, not a compliance determination. A
--     set flag routes to `needs_review` pending legal or compliance review; it
--     never renders as a decision, and no wording anywhere in this phase
--     advises anyone what it means for them.
--   * ABSENCE IS NOT GOOD STANDING. No row means Capiro has not looked. A row
--     with the flag clear means the provider reported none at that moment.
--     Neither is a clearance, and the read service says so on every response
--     including the ones with data.
--
-- THERE IS NO EXCLUSIONS ENDPOINT, AND THAT SHAPES THIS TABLE
-- -------------------------------------------------------------------
-- P17's capability probe established it against the real account:
-- @makegov/tango-node@1.1.0 exposes no exclusions resource, and the fields
-- live on the Entity record instead (`exclusion_status_flag`,
-- `exclusion_url`). `tango_entity_exclusion` is therefore an observation of an
-- entity's flag at a moment, carrying exactly what the Entity resource
-- carries — which means NO DATES. `exclusion_start_date`/`exclusion_end_date`
-- are declared and are always NULL today, kept because a future provider
-- release may add them and because the derivation rule already honours them
-- (the same posture P24 took for `psc_code`), not as an oversight.
--
-- Until dates exist, expiry rides on FRESHNESS: an observation older than the
-- staleness window reads `unverified`, never `active`, because "we saw a flag
-- three months ago" is not "they are excluded today". `observed_at` is
-- therefore NOT NULL — it is the column that judgement rests on.
--
-- SAME-NAME ENTITIES DO NOT INHERIT ANYTHING
-- -------------------------------------------------------------------
-- The exclusion table is keyed on UEI and nothing else, and the protest table
-- carries `protester_uei` alongside the docket's `protester_name` precisely so
-- a match can be made on the identifier rather than the name. A CHECK enforces
-- the 12-character UEI shape on both, so a malformed value cannot silently
-- become a key that matches the wrong company — the specific failure P02
-- removed from award history.
--
-- WHY GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- A GAO docket and a SAM exclusion are public records about the federal
-- marketplace, same category as every other tango_* catalog table.
--
-- LINKED BY EXACT IDENTIFIER OR NOT AT ALL
-- -------------------------------------------------------------------
-- `sam_opportunity_id` is populated only on an exact identifier match under
-- P27's own one-match rule, and is nullable forever — most protests will never
-- link to a notice Capiro holds. No foreign key, for the same reason P27's and
-- P28's ledgers have none: the record that a protest happened must outlive the
-- catalog row it once pointed at.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "tango_procurement_protest" (
  "id"                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  "tango_case_id"       TEXT NOT NULL,
  "case_number"         TEXT,
  -- 'gao' | 'cofc' as the provider states it. Deliberately NOT normalized into
  -- a Capiro vocabulary: the two forums have different procedures and the same
  -- outcome word means different things in each.
  "source_system"       TEXT,

  -- NULL means open, or the provider stated none. It does NOT mean the protest
  -- failed, and no CHECK or default may make it look like it does.
  "outcome"             TEXT,
  "case_type"           TEXT,
  "filed_date"          DATE,
  "decision_date"       DATE,

  "agency_name"         TEXT,
  "protester_name"      TEXT,
  -- The ONLY key a client match may use. See the header on same-name entities.
  "protester_uei"       TEXT,

  "docket"              JSONB,

  -- Exact-identifier link only. No FK: see the header.
  "sam_opportunity_id"  UUID,

  "snapshot"            JSONB NOT NULL,
  "source_url"          TEXT,

  "first_synced_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_synced_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- A protest with no provider case id has no identity, and the next sync would
-- create a second copy of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_procurement_protest_case_id_chk') THEN
    ALTER TABLE "tango_procurement_protest"
      ADD CONSTRAINT "tango_procurement_protest_case_id_chk"
      CHECK (btrim("tango_case_id") <> '');
  END IF;
END $$;

-- A decision cannot predate the filing. A row where it does is a mapping bug,
-- and left in it would render as a case decided before it existed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_procurement_protest_date_order_chk') THEN
    ALTER TABLE "tango_procurement_protest"
      ADD CONSTRAINT "tango_procurement_protest_date_order_chk"
      CHECK (
        "filed_date" IS NULL
        OR "decision_date" IS NULL
        OR "decision_date" >= "filed_date"
      );
  END IF;
END $$;

-- 12 characters or nothing. A malformed UEI would silently match the wrong
-- company, or none — and "none" reads as "this client has no protest history".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_procurement_protest_uei_chk') THEN
    ALTER TABLE "tango_procurement_protest"
      ADD CONSTRAINT "tango_procurement_protest_uei_chk"
      CHECK ("protester_uei" IS NULL OR char_length("protester_uei") = 12);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tango_procurement_protest_case_uniq"
  ON "tango_procurement_protest" ("tango_case_id");
CREATE INDEX IF NOT EXISTS "tango_procurement_protest_protester_idx"
  ON "tango_procurement_protest" ("protester_uei");
CREATE INDEX IF NOT EXISTS "tango_procurement_protest_opportunity_idx"
  ON "tango_procurement_protest" ("sam_opportunity_id");
CREATE INDEX IF NOT EXISTS "tango_procurement_protest_agency_idx"
  ON "tango_procurement_protest" ("agency_name");

CREATE TABLE IF NOT EXISTS "tango_entity_exclusion" (
  "id"                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- One current observation per entity, and the only key a match may use.
  "uei"                    TEXT NOT NULL,

  -- The provider's own flag value, verbatim. A BOOLEAN here would throw away
  -- the distinction between "the provider said no" and "the provider said
  -- nothing", and only the first of those is evidence.
  "exclusion_status_flag"  TEXT,
  "exclusion_url"          TEXT,

  -- ALWAYS NULL today. The Entity resource states neither; see the header.
  "exclusion_start_date"   DATE,
  "exclusion_end_date"     DATE,

  -- NOT NULL: while no dates exist this is the column expiry is judged on.
  "observed_at"            TIMESTAMPTZ(6) NOT NULL,

  "snapshot"               JSONB NOT NULL,

  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_entity_exclusion_uei_chk') THEN
    ALTER TABLE "tango_entity_exclusion"
      ADD CONSTRAINT "tango_entity_exclusion_uei_chk"
      CHECK (char_length("uei") = 12);
  END IF;
END $$;

-- If the provider ever DOES supply both dates, an end before a start is a
-- mapping bug. Written now rather than when the fields arrive: the constraint
-- costs nothing while both are null, and adding it later means adding it to a
-- table that already holds bad rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_entity_exclusion_date_order_chk') THEN
    ALTER TABLE "tango_entity_exclusion"
      ADD CONSTRAINT "tango_entity_exclusion_date_order_chk"
      CHECK (
        "exclusion_start_date" IS NULL
        OR "exclusion_end_date" IS NULL
        OR "exclusion_end_date" >= "exclusion_start_date"
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tango_entity_exclusion_uei_uniq"
  ON "tango_entity_exclusion" ("uei");
CREATE INDEX IF NOT EXISTS "tango_entity_exclusion_observed_idx"
  ON "tango_entity_exclusion" ("observed_at");
