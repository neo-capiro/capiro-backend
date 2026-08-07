-- Funding Opportunities P22 — relevant vehicles and past-performance sync.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- A MATERIALIZED, tenant-scoped summary: "this client (or its parent entity)
-- is an awardee on this Tango-tracked contract vehicle, with this
-- past-performance summary." The AUTHORITATIVE, versioned observation still
-- lives in the GLOBAL `tango_resource_snapshot` table (P15) — this table
-- exists purely so a fast, indexed, tenant-scoped read never has to scan
-- JSONB across every vehicle-awardee snapshot government-wide to answer
-- "which vehicles matter to THIS client".
--
-- "RELEVANT" IS THE OPERATIVE WORD
-- -------------------------------------------------------------------
-- The sync walks every vehicle and every awardee on it (there is no
-- awardee-UEI filter on the provider's list endpoints), but only PERSISTS —
-- to this table AND to `tango_resource_snapshot` — an awardee record that
-- actually matches a UEI Capiro already knows about. The overwhelming
-- majority of vehicles/awardees are irrelevant to any Capiro client and are
-- read, checked, and discarded without ever being written anywhere.
--
-- SELF VS PARENT: A DIFFERENT ANSWER TO "CAN THIS CLIENT BID"
-- -------------------------------------------------------------------
-- `TangoVehicleAwardee`'s own doc (tango.types.ts, P14) already draws this
-- line: "a parent UEI is a RELATED entity, never direct access... 'your
-- parent is on this vehicle' and 'you are on this vehicle' are different
-- answers to whether a client can bid." `relationship` carries that
-- distinction through to this table rather than collapsing it — P23 depends
-- on the two staying distinguishable.
--
-- WHY UPSERT, NOT VERSIONED LIKE tango_resource_snapshot
-- -------------------------------------------------------------------
-- This is a DERIVED summary, refreshed on each sync — not the authoritative
-- observation (that is P15's job, on the snapshot table, which this sync
-- also writes to for every relevant vehicle/awardee it finds). A summary
-- table re-computed on every run has no "history of the summary" to keep;
-- the underlying snapshot's OWN version history already answers "how has
-- this observation changed over time" for whoever needs that.
--
-- RLS
-- -------------------------------------------------------------------
-- Tenant-scoped, so RLS ENABLED + FORCED with the standard four
-- rls_bypass()/current_tenant_id() policies, per the client_funding_opportunity
-- (P07) / client_profile_enrichment_candidate (P20) template.
--
-- Every statement is retry-safe. A failed migration blocks every later one, so
-- a retry after a partial failure must be a no-op.

CREATE TABLE IF NOT EXISTS "client_relevant_vehicle" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    -- Matches tango_resource_snapshot.external_id for resourceType='vehicle'.
    -- Deliberately FK-less: that table is global and this is a summary, the
    -- same "no hard FK across the provider/tenant boundary" posture P13/P19
    -- already use for cross-rail pointers.
    "tango_vehicle_id" TEXT NOT NULL,
    "vehicle_name" TEXT,
    "vehicle_type" VARCHAR(64),
    -- 'self' | 'parent' — see this migration's own header for why these are
    -- never collapsed into one "is relevant" boolean.
    "relationship" VARCHAR(16) NOT NULL,
    "recipient_uei" VARCHAR(12) NOT NULL,
    "order_count" INTEGER,
    "idv_obligations" DOUBLE PRECISION,
    "idv_contracts_value" DOUBLE PRECISION,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "client_relevant_vehicle_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_relevant_vehicle_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_relevant_vehicle_client_fkey" FOREIGN KEY ("client_id")
        REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "client_relevant_vehicle_relationship_chk"
        CHECK ("relationship" IN ('self', 'parent'))
);

-- One summary row per (client, vehicle, relationship) — a client can be both
-- a self-awardee AND a parent-of-an-awardee on the same vehicle in principle
-- (an unusual but real corporate-structure case), and those are two
-- different facts, not a collision.
CREATE UNIQUE INDEX IF NOT EXISTS "client_relevant_vehicle_uniq"
    ON "client_relevant_vehicle" ("tenant_id", "client_id", "tango_vehicle_id", "relationship");

CREATE INDEX IF NOT EXISTS "client_relevant_vehicle_tenant_client_idx"
    ON "client_relevant_vehicle" ("tenant_id", "client_id");

ALTER TABLE "client_relevant_vehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_relevant_vehicle" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_relevant_vehicle' AND policyname = 'client_relevant_vehicle_select'
  ) THEN
    CREATE POLICY "client_relevant_vehicle_select" ON "client_relevant_vehicle"
        FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_relevant_vehicle' AND policyname = 'client_relevant_vehicle_insert'
  ) THEN
    CREATE POLICY "client_relevant_vehicle_insert" ON "client_relevant_vehicle"
        FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_relevant_vehicle' AND policyname = 'client_relevant_vehicle_update'
  ) THEN
    CREATE POLICY "client_relevant_vehicle_update" ON "client_relevant_vehicle"
        FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
        WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'client_relevant_vehicle' AND policyname = 'client_relevant_vehicle_delete'
  ) THEN
    CREATE POLICY "client_relevant_vehicle_delete" ON "client_relevant_vehicle"
        FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END $$;
