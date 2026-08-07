-- Funding Opportunities P44 — Tango budget beta context, in shadow mode.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- MakeGov/Tango's federal-account x fiscal-year budget rollup, plus the
-- contract flow out of those accounts to vendors Capiro already knows. It
-- illuminates EXECUTION — what an account was enacted, apportioned, obligated
-- and outlayed — as context beside an opportunity.
--
-- WHAT IT IS NOT, AND THIS IS THE WHOLE POINT
-- -------------------------------------------------------------------
-- It is not Capiro's budget data and it is not comparable to it. Capiro's
-- Program Element tables answer a different question at a different grain: a
-- LINE ITEM's request, congressional mark and enacted amount. A federal
-- account is an appropriation container that may hold many line items from
-- many programs. Putting the two numbers side by side and calling one a check
-- on the other is the specific error this phase is shaped to prevent, so:
--
--   * this migration writes NO Program Element, project, request, mark,
--     enacted or canonical defense-budget table, and adds no column to one;
--   * any relationship between an account and a PE is a CAPIRO mapping with
--     its own recorded basis — a provider assertion is not one, and no
--     column here can express it;
--   * the read service refuses to emit a comparison across unlike scope,
--     fiscal year or stage, and its spec proves the refusal.
--
-- WHY GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- "Federal account 097-0400 obligated $X in FY26" is a fact about the federal
-- government, same category as tango_procurement_forecast (P24),
-- tango_resource_snapshot (P15) and sam_opportunity/federal_grant (P00).
-- Omitting tenant_id is also what keeps a plain
-- `this.prisma.tangoBudgetAccount.*` call correctly UNFLAGGED by
-- tenant-scope-guard.spec.ts.
--
-- The vendor-flow table is global for the same reason even though a UEI
-- filter decides what gets WRITTEN. That filter is a relevance rule, not a
-- tenancy boundary: "vendor X received $Y from account Z" is public, and two
-- tenants knowing the same vendor must not produce two rows saying it.
--
-- WHY A SINGLE CURRENT-STATE TABLE, NOT ANOTHER tango_resource_snapshot LAYER
-- -------------------------------------------------------------------
-- Same deliberate deviation P24 made and recorded as decision-log D-46, and
-- one extra reason specific to this resource: a budget rollup's history IS the
-- fiscal-year dimension the table already carries. A second versioning axis
-- would store the same fact twice and invite the two to disagree about which
-- FY26 obligation figure is current.
--
-- THE MONEY COLUMNS ARE NULLABLE, AND NULL IS NOT ZERO
-- -------------------------------------------------------------------
-- Live observation from this phase's own shape probe against the real account
-- (21,171 rows in /api/budget/accounts/): on a genuine row `contract_obligated`
-- carried a number while `enacted_ba`, `requested_ba`, `apportioned`,
-- `obligated_total`, `outlayed_total` and `unobligated_balance` were ALL null,
-- and `agency_code` was null beside a populated `agency_name`. An account the
-- provider has not attributed is not an account with no money. NUMERIC, not
-- double precision: these are dollars, and a float that rounds an obligation
-- is a number nobody can reconcile against the source.
--
-- NOTHING WRITES TO THESE TABLES YET
-- -------------------------------------------------------------------
-- P44's file list names no sync script, deliberately — same posture as P15's
-- substrate and P24's schema-before-producer split. The mapper and the read
-- service ship with the tables; population is a later, separately reviewable
-- step, and until then the panel reports "not yet synced" rather than "this
-- account has no money".
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS, so a half-applied run can be
-- re-applied cleanly. A failed migration blocks every later one.

CREATE TABLE IF NOT EXISTS "tango_budget_account" (
  "id"                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The provider's own row id for this account x fiscal-year pair, and the
  -- sync's upsert key. UNIQUE is what makes a duplicate provider page a no-op
  -- rather than a second opinion about the same account.
  "tango_account_row_id"    INTEGER NOT NULL,

  "federal_account_symbol"  TEXT NOT NULL,
  "fiscal_year"             INTEGER NOT NULL,
  "account_title"           TEXT NOT NULL,

  -- Nullable, and observed NULL on a live row beside a populated agency_name.
  "agency_code"             TEXT,
  "agency_name"             TEXT,
  "bureau_name"             TEXT,

  "bea_category"            TEXT,
  "on_off_budget"           TEXT,
  "subfunction_code"        TEXT,

  -- Budget authority and execution. See the header: every one nullable.
  "requested_ba"            NUMERIC(20, 2),
  "enacted_ba"              NUMERIC(20, 2),
  "apportioned"             NUMERIC(20, 2),
  "obligated_total"         NUMERIC(20, 2),
  "outlayed_total"          NUMERIC(20, 2),
  "unobligated_balance"     NUMERIC(20, 2),
  "contract_obligated"      NUMERIC(20, 2),
  "assistance_obligated"    NUMERIC(20, 2),

  -- The provider's OWN confidence in its attribution, carried verbatim. This
  -- is what makes the beta label honest rather than decorative.
  "attribution_status"      TEXT,
  "attribution_confidence"  TEXT,

  "snapshot"                JSONB NOT NULL,
  "source_url"              TEXT,

  "first_synced_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_synced_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- A fiscal year outside a sane window is a mapping bug, not a budget. The
-- upper bound is deliberately generous: agencies publish out-year projections,
-- and refusing a real FY32 row to catch a typo would be the worse trade.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_budget_account_fiscal_year_chk') THEN
    ALTER TABLE "tango_budget_account"
      ADD CONSTRAINT "tango_budget_account_fiscal_year_chk"
      CHECK ("fiscal_year" BETWEEN 1990 AND 2100);
  END IF;
END $$;

-- A federal account symbol is an identifier a human reads off a Treasury
-- document. Blank is never one, and a blank here would silently become a join
-- key that matches every other blank.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_budget_account_symbol_chk') THEN
    ALTER TABLE "tango_budget_account"
      ADD CONSTRAINT "tango_budget_account_symbol_chk"
      CHECK (btrim("federal_account_symbol") <> '');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tango_budget_account_row_id_uniq"
  ON "tango_budget_account" ("tango_account_row_id");
CREATE INDEX IF NOT EXISTS "tango_budget_account_symbol_fy_idx"
  ON "tango_budget_account" ("federal_account_symbol", "fiscal_year");
CREATE INDEX IF NOT EXISTS "tango_budget_account_agency_idx"
  ON "tango_budget_account" ("agency_code");

CREATE TABLE IF NOT EXISTS "tango_budget_vendor_flow" (
  "id"                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  "budget_account_id"        UUID NOT NULL,

  -- The join key, and the reason this row exists at all. The provider's
  -- recipients endpoint returns every recipient of an account; only a UEI
  -- Capiro already knows is persisted, the same "walk everything, keep what we
  -- can defend" rule P22 applied to vehicle awardees.
  "recipient_uei"            TEXT NOT NULL,
  "recipient_name"           TEXT,

  "funding_organization_id"  TEXT,
  "funding_office_code"      TEXT,
  "funding_office_name"      TEXT,
  "funding_agency_code"      TEXT,
  "funding_agency_name"      TEXT,

  "contract_obligated"       NUMERIC(20, 2),
  "contract_outlayed"        NUMERIC(20, 2),
  "contract_count"           INTEGER,

  "last_synced_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tango_budget_vendor_flow_account_fkey'
  ) THEN
    ALTER TABLE "tango_budget_vendor_flow"
      ADD CONSTRAINT "tango_budget_vendor_flow_account_fkey"
      FOREIGN KEY ("budget_account_id") REFERENCES "tango_budget_account"("id")
      ON DELETE CASCADE;
  END IF;
END $$;

-- CASCADE, unlike P27's and P28's deliberately FK-free ledgers. The difference
-- is what the row MEANS: a parity record is evidence that two catalogs once
-- disagreed and has to outlive either of them, whereas a vendor flow is a
-- breakdown OF an account and is meaningless without it. An orphaned flow row
-- would be a dollar figure attributed to nothing.

-- A UEI is a government identifier, always 12 characters. A blank or
-- wrong-length value here is a mapping bug that would silently fail to match
-- any client, which reads as "this vendor received nothing".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_budget_vendor_flow_uei_chk') THEN
    ALTER TABLE "tango_budget_vendor_flow"
      ADD CONSTRAINT "tango_budget_vendor_flow_uei_chk"
      CHECK (char_length("recipient_uei") = 12);
  END IF;
END $$;

-- One row per (account, recipient, funding office). COALESCE on the office,
-- because Postgres treats NULLs as distinct and a plain composite would admit
-- unlimited duplicate rows for a flow the provider reported with no office —
-- the same trap P29's attachment uniqueness had to COALESCE its way out of.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_budget_vendor_flow_grain_uniq"
  ON "tango_budget_vendor_flow" (
    "budget_account_id",
    "recipient_uei",
    COALESCE("funding_organization_id", '')
  );
CREATE INDEX IF NOT EXISTS "tango_budget_vendor_flow_uei_idx"
  ON "tango_budget_vendor_flow" ("recipient_uei");
CREATE INDEX IF NOT EXISTS "tango_budget_vendor_flow_account_idx"
  ON "tango_budget_vendor_flow" ("budget_account_id");
