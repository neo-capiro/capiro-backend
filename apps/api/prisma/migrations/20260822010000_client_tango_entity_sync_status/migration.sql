-- Funding Opportunities P19 — MakeGov/Tango entity shadow sync status.
--
-- WHY THIS LIVES ON `clients`, NOT A NEW TABLE OR TangoResourceLink
-- -------------------------------------------------------------------
-- The fetched Tango Entity DATA already has a home: the GLOBAL
-- `tango_resource_snapshot` table (P15), keyed by `(resource_type, external_id)`
-- where `external_id` is the UEI. A client's own `uei` column is that SAME key.
-- A UEI is a global, exact, 1:1 government identifier, so "which snapshot goes
-- with this client" needs no join table at all — `WHERE external_id = client.uei`
-- IS the relationship.
--
-- `tango_resource_link` (also P15) is NOT the right place either:
-- `assertKnownLocalType` in tango-store.service.ts explicitly refuses a
-- tenant-owned local resource type, and `clients` carries `tenant_id`. That
-- table exists to link a Tango resource into one of Capiro's own GLOBAL
-- reference tables (federal_contractor et al.), never to a tenant's client
-- row. Three columns on `clients` itself is the honest shape for a fact that
-- is, in truth, about one client's own sync bookkeeping.
--
-- WHY TWO TIMESTAMPS, NOT ONE
-- -------------------------------------------------------------------
-- `tango_entity_last_synced_at` is the last SUCCESSFUL sync — success meaning
-- a definitive provider answer, found OR not_found (tango.errors.ts already
-- treats not_found as evidence, not a failure). `tango_entity_last_attempt_at`
-- is the latest attempt regardless of outcome, tracked independently so a
-- client whose sync has been failing on every run cannot read as healthy just
-- because it succeeded once, long ago. Same distinction this program already
-- documents for source freshness generally
-- (baseline-contract-v1.json's `sourceFreshnessSemantics`).
--
-- ADDITIVE, NULLABLE, NO DEFAULT, NO BACKFILL
-- -------------------------------------------------------------------
-- NULL means "never synced", which is the correct and only honest state for
-- every existing row — this program has never made a Tango call before this
-- migration. No backfill invents a sync that never happened.
--
-- RLS
-- -------------------------------------------------------------------
-- `clients` already has RLS ENABLED and FORCED with its own tenant policies.
-- Adding columns does not change any of that, and this migration does not
-- touch a single policy — re-issuing one risks silently replacing it with a
-- subtly different predicate for no reason this migration needs.
--
-- Every statement is retry-safe. A failed migration blocks every later one, so
-- a retry after a partial failure must be a no-op.

ALTER TABLE "clients"
    ADD COLUMN IF NOT EXISTS "tango_entity_last_synced_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "tango_entity_last_attempt_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "tango_entity_last_error" TEXT;
