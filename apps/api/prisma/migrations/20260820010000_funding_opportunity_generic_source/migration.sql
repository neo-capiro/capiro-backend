-- P13 — Generic opportunity source identity bridge.
--
-- WHAT THIS DOES
-- --------------
-- Adds two nullable columns to client_funding_opportunity, backfills them for
-- every existing row, widens the source vocabulary CHECK, replaces the
-- source-exclusivity CHECK with one that also admits a generic-identity row, and
-- adds a partial unique index over the generic identity.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- It does not drop, rename or narrow anything. `grant_opportunity_id` and
-- `sam_opportunity_id` stay, keep being written, and remain REQUIRED for their
-- respective sources. Removing them is a separate contract phase that has not
-- been approved.
--
-- It enables no new source. Widening the vocabulary CHECK is what makes the
-- generic branch of the exclusivity CHECK reachable, and therefore testable — an
-- unreachable constraint is an untested one. No code path can produce
-- 'agency_forecast', 'dibbs' or 'sbir_sttr': the API's own OPPORTUNITY_SOURCES
-- list is unchanged, and every DTO, filter and route validates against that.
--
-- ROLLING-DEPLOY SAFETY, BOTH DIRECTIONS
-- --------------------------------------
-- The columns are NULLABLE with no default, and for the two legacy sources the
-- new CHECK treats them as OPTIONAL. That is what makes the migration safe to
-- apply BEFORE the API rolls:
--
--   Old code inserting after the migration — sets neither column. Allowed,
--     because the legacy branch requires only the legacy pointer.
--   New code reading such a row            — falls back to the legacy pointer
--     (readSourceRecordId in funding-opportunity-identity.ts), and backfills the
--     generic pair the first time it updates the row.
--   Old code reading a NEW row             — reads the legacy pointer, which new
--     code still writes.
--
-- A NOT NULL on either column would break the first of those on the first insert.
--
-- Retry-safe: every statement is IF NOT EXISTS or guarded by a catalog lookup, so
-- a half-applied migration can be re-run. A failed migration blocks every later
-- one, which is why that matters more than it looks.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The two generic identity columns.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "client_funding_opportunity"
    ADD COLUMN IF NOT EXISTS "source_record_type" VARCHAR(48),
    ADD COLUMN IF NOT EXISTS "source_record_key"  TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Deterministic backfill.
--
-- The key is a COPY of the legacy pointer, not a derived or hashed value, so the
-- mapping is obvious to a human reading a row and reversible without this file.
-- `sam_opportunity_id` is a uuid; ::text is the canonical lower-case form, which
-- is what the API compares against.
--
-- Guarded on IS NULL so a re-run is a no-op and so a row a NEWER writer already
-- filled is never rewritten.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE "client_funding_opportunity"
   SET "source_record_type" = 'grants_gov_opportunity',
       "source_record_key"  = "grant_opportunity_id"
 WHERE "source" = 'grants_gov'
   AND "grant_opportunity_id" IS NOT NULL
   AND "source_record_key" IS NULL;

UPDATE "client_funding_opportunity"
   SET "source_record_type" = 'sam_notice',
       "source_record_key"  = "sam_opportunity_id"::text
 WHERE "source" = 'sam_gov'
   AND "sam_opportunity_id" IS NOT NULL
   AND "source_record_key" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Widen the source vocabulary.
--
-- ADDITIVE: every value the old CHECK allowed is still allowed, so no existing
-- row can fail validation. The three new values are the sources this program
-- introduces later (P24 forecasts, P40 DIBBS, P42 SBIR/STTR). Each is enabled by
-- its own phase adding it to OPPORTUNITY_SOURCES and shipping a producer.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "client_funding_opportunity"
    DROP CONSTRAINT IF EXISTS "client_funding_opportunity_source_chk";

ALTER TABLE "client_funding_opportunity"
    ADD CONSTRAINT "client_funding_opportunity_source_chk"
    CHECK ("source" IN ('grants_gov', 'sam_gov', 'agency_forecast', 'dibbs', 'sbir_sttr'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The expanded exclusivity CHECK.
--
-- Three branches, and the difference between them is the whole phase:
--
--   grants_gov — legacy pointer REQUIRED, the other pointer absent, and the
--                generic pair optional but, when present, consistent.
--   sam_gov    — the mirror of that.
--   anything else — NO legacy pointer, and the generic pair REQUIRED.
--
-- The "when present, consistent" clause is what stops a row from claiming
-- source='sam_gov' while its generic type says it is a grant: a later phase
-- joining on source_record_type would silently read it from the wrong table.
--
-- The generic pair is all-or-nothing everywhere. A key with no type cannot be
-- resolved to a table; a type with no key names nothing.
--
-- THE `IS NOT NULL` BEFORE EACH `=` IS LOAD-BEARING, NOT BELT-AND-BRACES.
-- A CHECK passes when it evaluates to TRUE *or to NULL*, and `NULL = 'x'` is NULL,
-- not FALSE. Written as
--
--   (key IS NULL AND type IS NULL) OR (key IS NOT NULL AND type = 'grants_gov_opportunity')
--
-- a row with a key and a NULL type takes `FALSE OR NULL` → NULL → and Postgres
-- ADMITS IT. Rehearsed against pgvector:pg16 before this comment was written: that
-- exact row inserted successfully. Making each `=` conjunct explicitly reject NULL
-- turns the branch FALSE and the row is refused.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "client_funding_opportunity"
    DROP CONSTRAINT IF EXISTS "client_funding_opportunity_one_source_chk";

ALTER TABLE "client_funding_opportunity"
    ADD CONSTRAINT "client_funding_opportunity_one_source_chk" CHECK (
      (
        "source" = 'grants_gov'
        AND "grant_opportunity_id" IS NOT NULL
        AND "sam_opportunity_id" IS NULL
        AND (
          ("source_record_key" IS NULL AND "source_record_type" IS NULL)
          OR (
            "source_record_key" IS NOT NULL
            AND "source_record_type" IS NOT NULL
            AND "source_record_type" = 'grants_gov_opportunity'
          )
        )
      )
      OR (
        "source" = 'sam_gov'
        AND "sam_opportunity_id" IS NOT NULL
        AND "grant_opportunity_id" IS NULL
        AND (
          ("source_record_key" IS NULL AND "source_record_type" IS NULL)
          OR (
            "source_record_key" IS NOT NULL
            AND "source_record_type" IS NOT NULL
            AND "source_record_type" = 'sam_notice'
          )
        )
      )
      OR (
        "source" NOT IN ('grants_gov', 'sam_gov')
        AND "grant_opportunity_id" IS NULL
        AND "sam_opportunity_id" IS NULL
        AND "source_record_key" IS NOT NULL
        AND "source_record_type" IS NOT NULL
      )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Uniqueness on the generic identity.
--
-- PARTIAL, like the two legacy unique indexes and for the same reason: Postgres
-- treats NULLs as distinct, and without the predicate every not-yet-backfilled
-- row would be a distinct NULL — which is fine — but the index would also be
-- carrying them for nothing. More importantly the predicate documents that a NULL
-- key is a legitimate legacy state rather than a gap to be filled.
--
-- `source` is IN the key. Two rails could legitimately mint the same opaque
-- string, and (tenant, client, key) alone would collide them into one decision
-- record.
--
-- Redundant with the legacy uniques for legacy rows, deliberately: that
-- redundancy is what proves the generic identity is as unique as the thing it
-- mirrors, on live data, before anything depends on it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_generic_uniq"
    ON "client_funding_opportunity" ("tenant_id", "client_id", "source", "source_record_key")
    WHERE "source_record_key" IS NOT NULL;

-- The lookup index for the dual-read path and for later phases resolving a row
-- back to its source table. Not unique: it deliberately spans tenants, because
-- "which decision records point at this forecast" is a cross-tenant operator
-- question, and RLS still applies to any read that asks it.
CREATE INDEX IF NOT EXISTS "client_funding_opportunity_source_record_idx"
    ON "client_funding_opportunity" ("tenant_id", "source_record_type", "source_record_key");
