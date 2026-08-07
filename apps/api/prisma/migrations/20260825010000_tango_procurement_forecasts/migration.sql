-- Funding Opportunities P24 — agency forecast schema and incremental sync.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- Pre-SAM early signals ("here is what we expect to buy") as their own
-- source lifecycle, never called a solicitation or an active competition.
--
-- WHY tango_procurement_forecast IS GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- A forecast is a fact about the FEDERAL MARKETPLACE, not about any one
-- tenant — exactly the same reasoning tango_resource_snapshot (P15) and
-- sam_opportunity/federal_grant (P00) already carry. Omitting tenant_id is
-- what keeps a plain `this.prisma.tangoProcurementForecast.*` call correctly
-- UNFLAGGED by tenant-scope-guard.spec.ts.
--
-- WHY A SINGLE CURRENT-STATE TABLE, NOT ANOTHER tango_resource_snapshot LAYER
-- -------------------------------------------------------------------
-- P19/P20/P22 all write their provider observation to the GLOBAL, versioned
-- `tango_resource_snapshot` (P15) in addition to their own summary table.
-- This phase deliberately does not: tango_resource_snapshot's versioned-head
-- design exists to keep a full audit trail for a LOW-volume, per-client-
-- relevant resource. A forecast is a HIGH-volume catalog record (24,000+
-- live rows, confirmed against the real account) that Capiro tracks the
-- CURRENT state of — the same shape of resource sam_opportunity and
-- federal_grant already are as single current-state tables, upserted on
-- every sync rather than versioned. `snapshot` holds the full normalized
-- shape of the MOST RECENT observation for audit/debugging; an upsert
-- overwrites it, it does not grow a new row. See decision-log D-46.
--
-- WHY THE COLUMN LIST IS RICHER THAN P14's ORIGINAL TangoForecast
-- -------------------------------------------------------------------
-- A live-key investigation for this phase found the provider's forecast
-- resource carries a real `organization` hierarchy and a real `modified`
-- timestamp that the SDK's own bundled schema does not declare at all (so
-- neither was reachable through the SDK's typed `listForecasts` — only
-- through its raw HTTP transport, which the live server accepts without
-- complaint), and that `primary_contact` is a structured object server-side
-- despite the SDK typing it as a plain string. See decision-log D-45 for the
-- full investigation. `psc_code` and `source_url` stay as columns — a future
-- provider release may add either — but are confirmed ABSENT from this
-- resource's own available_fields today, not an oversight.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS, so a half-applied run can be
-- re-applied cleanly. A failed migration blocks every later one.

CREATE TABLE IF NOT EXISTS "tango_procurement_forecast" (
    "id"                          UUID NOT NULL DEFAULT uuid_generate_v4(),
    -- The sync's own upsert key.
    "tango_forecast_id"           TEXT NOT NULL,
    "external_id"                 TEXT,
    "title"                       TEXT NOT NULL,
    "description"                 TEXT,
    -- The provider's own flat agency label — distinct from, and not always
    -- consistent with, the organization hierarchy below (decision-log D-45).
    "agency"                      TEXT,
    "department_code"             TEXT,
    "department_name"             TEXT,
    "organization_agency_code"    TEXT,
    "organization_agency_name"    TEXT,
    "office_code"                 TEXT,
    "office_name"                 TEXT,
    "organization_id"             TEXT,
    "anticipated_award_date"      DATE,
    -- Free text, e.g. "Q3 FY27". Not a date, never parsed into one.
    "estimated_period"            TEXT,
    "fiscal_year"                 INTEGER,
    "naics_code"                  TEXT,
    -- ALWAYS NULL today. Confirmed absent from the provider's own
    -- available_fields for this resource (decision-log D-45).
    "psc_code"                    TEXT,
    "set_aside"                   TEXT,
    -- Free text naming a vehicle. No separate structured link exists on this
    -- resource (D-45) — "vehicle text/link" in the plan is one field, not two.
    "contract_vehicle"            TEXT,
    -- Free text, not a structured address.
    "place_of_performance"        TEXT,
    -- Structured on the live server (D-45); flattened to columns since this
    -- table carries no separate JSON contact field.
    "primary_contact_name"        TEXT,
    "primary_contact_email"       TEXT,
    "primary_contact_phone"       TEXT,
    "primary_contact_title"       TEXT,
    "status"                      TEXT,
    "is_active"                   BOOLEAN,
    "source_system"               TEXT,
    -- ALWAYS NULL today. Confirmed absent (decision-log D-45).
    "source_url"                  TEXT,
    -- The provider's own last-touched stamp (D-45). Drives the incremental
    -- sync's modified_after window. Null when the provider never stated one.
    "provider_modified_at"        TIMESTAMPTZ(6),
    -- Full normalized shape of the most recent observation. Overwritten on
    -- every sync — see this migration's own header for why this is not
    -- versioned like tango_resource_snapshot.
    "snapshot"                    JSONB NOT NULL,
    "first_synced_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_synced_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tango_procurement_forecast_pkey" PRIMARY KEY ("id")
);

-- The sync's own upsert key. One row per forecast, ever.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_procurement_forecast_tango_forecast_id_key"
    ON "tango_procurement_forecast" ("tango_forecast_id");

CREATE INDEX IF NOT EXISTS "tango_procurement_forecast_fiscal_year_idx"
    ON "tango_procurement_forecast" ("fiscal_year");

CREATE INDEX IF NOT EXISTS "tango_procurement_forecast_agency_idx"
    ON "tango_procurement_forecast" ("agency");

-- The incremental sync's own window key — reading "everything modified since
-- the last checkpoint" is exactly this index's shape.
CREATE INDEX IF NOT EXISTS "tango_procurement_forecast_modified_idx"
    ON "tango_procurement_forecast" ("provider_modified_at");
