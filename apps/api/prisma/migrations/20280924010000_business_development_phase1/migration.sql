-- Business Development Phase 1 — additive persistence.
--
-- Three new tenant-scoped tables (prospects, prospect activity, firm
-- preferences) plus ONE nullable additive column on clients
-- (canonical_entity_id) with a partial unique index so an exact
-- confirmed-identity client link is reusable and duplicate-safe per firm.
-- Every new tenant table gets the standard RLS ENABLE + FORCE + isolation
-- policy pair (current_tenant_id()/rls_bypass() helpers from the tenancy
-- init migration). No existing row is changed; no global canonical
-- organization is ever created from a manual prospect.

-- ── 1. Firm prospects ──────────────────────────────────────────────────────

CREATE TABLE "business_development_prospects" (
  "id"                   UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"            UUID NOT NULL,
  -- NULL until the firm confirms a canonical identity. One prospect per
  -- (tenant, confirmed canonical entity) — INCLUDING dismissed rows — enforced
  -- by the partial unique index below. Unresolved records have NO
  -- name/domain uniqueness by design: two "Acme" research rows coexist.
  "canonical_entity_id"  UUID,
  -- Always present so lists render pre-resolution. Private to this tenant;
  -- NEVER copied into shared canonical rows.
  "display_name"         TEXT NOT NULL,
  "domain"               TEXT,
  "website"              TEXT,
  "description"          TEXT,
  "service_hypothesis"    TEXT,
  "geography"            TEXT,
  -- Validated in the service against an ACTIVE TenantMembership of the same
  -- tenant before any write; plain UUID, no FK (mirrors Client.createdByUserId
  -- so a departed owner never breaks reads).
  "owner_user_id"        UUID,
  "stage"                VARCHAR(16) NOT NULL DEFAULT 'researching',
  "status"               VARCHAR(16) NOT NULL DEFAULT 'active',
  "dismissed_at"         TIMESTAMPTZ(6),
  -- Private conflict/exclusion state (conflicts of interest). Reason is
  -- firm-private; never surfaced to another tenant or written to canonical rows.
  "conflict_excluded"    BOOLEAN NOT NULL DEFAULT false,
  "conflict_reason"      TEXT,
  "next_action"          TEXT,
  "next_action_due_at"   TIMESTAMPTZ(6),
  -- The conversion link. Same-tenant enforced in the service; at most one
  -- prospect per client is enforced by a partial unique index below.
  "linked_client_id"     UUID,
  "converted_at"         TIMESTAMPTZ(6),
  -- Phase 1 stores the request ONLY — no polling, no alert delivery.
  "watch_requested"      BOOLEAN NOT NULL DEFAULT false,
  "created_by_user_id"  UUID,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_prospects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_development_prospects_stage_check"
    CHECK ("stage" IN ('researching', 'qualified', 'outreach', 'meeting', 'proposal', 'won', 'lost', 'parked')),
  CONSTRAINT "business_development_prospects_status_check"
    CHECK ("status" IN ('active', 'dismissed')),
  CONSTRAINT "business_development_prospects_dismissed_check"
    CHECK (("status" = 'dismissed') = ("dismissed_at" IS NOT NULL)),
  CONSTRAINT "business_development_prospects_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "business_development_prospects_canonical_fkey"
    FOREIGN KEY ("canonical_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT,
  CONSTRAINT "business_development_prospects_client_fkey"
    FOREIGN KEY ("linked_client_id") REFERENCES "clients"("id") ON DELETE RESTRICT
);

-- ONE prospect per (tenant, confirmed canonical entity), dismissed rows
-- included: a dismissed row still blocks a silent second record for the same
-- confirmed org; the create path RESTORES the dismissed row instead.
CREATE UNIQUE INDEX "business_development_prospects_tenant_canonical_key"
  ON "business_development_prospects"("tenant_id", "canonical_entity_id")
  WHERE "canonical_entity_id" IS NOT NULL;

-- At most one prospect row per linked client (conversion target).
CREATE UNIQUE INDEX "business_development_prospects_client_key"
  ON "business_development_prospects"("linked_client_id")
  WHERE "linked_client_id" IS NOT NULL;

CREATE INDEX "business_development_prospects_tenant_status_stage_idx"
  ON "business_development_prospects"("tenant_id", "status", "stage");
CREATE INDEX "business_development_prospects_tenant_updated_idx"
  ON "business_development_prospects"("tenant_id", "updated_at" DESC);
CREATE INDEX "business_development_prospects_tenant_owner_idx"
  ON "business_development_prospects"("tenant_id", "owner_user_id");
CREATE INDEX "business_development_prospects_tenant_client_idx"
  ON "business_development_prospects"("tenant_id", "linked_client_id");
CREATE INDEX "business_development_prospects_tenant_name_idx"
  ON "business_development_prospects"("tenant_id", "display_name");

-- ── 2. Prospect activity / note history ─────────────────────────────────────

CREATE TABLE "business_development_prospect_activity" (
  "id"           UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"    UUID NOT NULL,
  "prospect_id"  UUID NOT NULL,
  "actor_user_id" UUID,
  "kind"         VARCHAR(24) NOT NULL DEFAULT 'note',
  "body"         TEXT NOT NULL,
  -- before/after metadata for system events (stage changes, conversion,
  -- conflict updates). Never carries private note bodies.
  "before_jsonb"  JSONB,
  "after_jsonb"   JSONB,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_prospect_activity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_development_prospect_activity_kind_check"
    CHECK ("kind" IN ('note', 'stage', 'owner', 'dismiss', 'restore', 'conflict', 'watch', 'convert', 'identity')),
  CONSTRAINT "business_development_prospect_activity_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- CASCADE: activity belongs to the prospect. History survives dismissal and
  -- conversion (dismissal only flips status; conversion only sets the client
  -- link) — deleting the prospect deletes its history.
  CONSTRAINT "business_development_prospect_activity_prospect_fkey"
    FOREIGN KEY ("prospect_id") REFERENCES "business_development_prospects"("id") ON DELETE CASCADE
);

CREATE INDEX "business_development_prospect_activity_prospect_idx"
  ON "business_development_prospect_activity"("tenant_id", "prospect_id", "created_at" DESC);

-- ── 3. Firm preferences (one row per tenant) ────────────────────────────────

CREATE TABLE "business_development_preferences" (
  "id"                    UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"             UUID NOT NULL,
  "practice_service_areas" TEXT[] NOT NULL DEFAULT '{}',
  "agencies_issues"        TEXT[] NOT NULL DEFAULT '{}',
  "geographies"           TEXT[] NOT NULL DEFAULT '{}',
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_development_preferences_tenant_key" UNIQUE ("tenant_id"),
  CONSTRAINT "business_development_preferences_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

-- ── 4. Client canonical-entity link (additive, nullable) ────────────────────

ALTER TABLE "clients"
  ADD COLUMN "canonical_entity_id" UUID;

-- At most one client per (tenant, canonical entity) when the firm has
-- confirmed an exact identity. Reversible by clearing the column; existing
-- NULL rows are untouched by the partial predicate.
CREATE UNIQUE INDEX "clients_tenant_canonical_entity_key"
  ON "clients"("tenant_id", "canonical_entity_id")
  WHERE "canonical_entity_id" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_canonical_entity_fkey') THEN
    ALTER TABLE "clients"
      ADD CONSTRAINT "clients_canonical_entity_fkey"
      FOREIGN KEY ("canonical_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT;
  END IF;
END
$$;

-- ── 5. RLS on every new tenant table ────────────────────────────────────────

ALTER TABLE "business_development_prospects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_prospects" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_prospects_isolation" ON "business_development_prospects"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "business_development_prospect_activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_prospect_activity" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_prospect_activity_isolation" ON "business_development_prospect_activity"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "business_development_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_preferences_isolation" ON "business_development_preferences"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── 6. Grants ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "business_development_prospects",
      "business_development_prospect_activity",
      "business_development_preferences"
      TO capiro_app;
  END IF;
END
$$;
