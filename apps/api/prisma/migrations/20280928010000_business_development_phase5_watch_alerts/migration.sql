-- Business Development Phase 5 — watch + alert persistence.
--
-- Additive, tenant-private, rollback-safe. Four new tables:
--   business_development_watches             one watch per (tenant, prospect);
--   business_development_watch_source_states  per-watch, per-source runner
--                                            state with quiet baseline, complete
--                                            cursor, health, and a DB-only
--                                            evaluator lease (lease_token /
--                                            lease_until) for overlapping ECS
--                                            tasks;
--   business_development_alerts              append-only tenant alerts with
--                                            semantic fingerprint + dedupe
--                                            uniques;
--   business_development_alert_deliveries    idempotent in-app delivery per
--                                            (tenant, alert, recipient,
--                                            channel).
--
-- NO ingestion is added by this migration. Sources are EXISTING canonical
-- projections only (federal_award, federal_assistance_award, sam_opportunity,
-- tango_resource, lda_filing, acquisition_revision); the evaluator that
-- already ticks reads them through these state rows. watch_requested on
-- business_development_prospects is PRESERVED unchanged for compatibility;
-- the backfill below seeds one ACTIVE watch per existing watch_requested=true
-- prospect with baselined_at NULL — the runner creates a QUIET baseline and
-- this migration manufactures ZERO alerts.
--
-- No existing row or table is changed. Every new table gets the standard RLS
-- ENABLE + FORCE + isolation policy pair and closed-vocabulary CHECK
-- constraints (finite string values). The project does not use SQL updated_at
-- triggers; Prisma @updatedAt owns updated_at.

-- ── 1. Watches (one per tenant+prospect) ───────────────────────────────────

CREATE TABLE "business_development_watches" (
  "id"                    UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"             UUID NOT NULL,
  "prospect_id"           UUID NOT NULL,
  -- PLAIN UUID, no DB foreign key (mirrors prospect owner_user_id): a
  -- departed owner never breaks reads and watch history stays intact.
  "owner_user_id"         UUID,
  "status"                VARCHAR(16) NOT NULL DEFAULT 'active',
  "muted_until"           TIMESTAMPTZ(6),
  "categories"            TEXT[] NOT NULL DEFAULT '{}',
  "frequency"             VARCHAR(16),
  "digest"                BOOLEAN NOT NULL DEFAULT false,
  "preference_version"   INTEGER NOT NULL DEFAULT 1,
  "requested_by_user_id"  UUID,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_watches_pkey" PRIMARY KEY ("id"),
  -- FK-target criterion for the state/alert composite FKs below.
  CONSTRAINT "business_development_watches_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  -- ONE watch per (tenant, prospect), dismissed/converted prospects included.
  CONSTRAINT "business_development_watches_tenant_prospect_key"
    UNIQUE ("tenant_id", "prospect_id"),
  CONSTRAINT "business_development_watches_status_check"
    CHECK ("status" IN ('active', 'paused', 'ended')),
  CONSTRAINT "business_development_watches_frequency_check"
    CHECK ("frequency" IS NULL OR "frequency" IN ('real_time', 'daily', 'weekly')),
  CONSTRAINT "business_development_watches_preference_version_check"
    CHECK ("preference_version" >= 1),
  CONSTRAINT "business_development_watches_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Tenant-safe prospect link: the composite FK guarantees the prospect
  -- belongs to the SAME tenant. CASCADE mirrors prospect activity history.
  CONSTRAINT "business_development_watches_prospect_fkey"
    FOREIGN KEY ("tenant_id", "prospect_id")
    REFERENCES "business_development_prospects"("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "business_development_watches_tenant_status_muted_idx"
  ON "business_development_watches"("tenant_id", "status", "muted_until");
CREATE INDEX "business_development_watches_tenant_owner_idx"
  ON "business_development_watches"("tenant_id", "owner_user_id");
CREATE INDEX "business_development_watches_tenant_updated_idx"
  ON "business_development_watches"("tenant_id", "updated_at" DESC);

-- ── 2. Per-watch, per-source state ────────────────────────────────────────

CREATE TABLE "business_development_watch_source_states" (
  "id"                                  UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"                           UUID NOT NULL,
  "watch_id"                            UUID NOT NULL,
  -- EXISTING canonical projections only. No new source family may appear
  -- without a migration: this CHECK is the allowlist.
  "source_family"                       VARCHAR(32) NOT NULL,
  "health"                              VARCHAR(16) NOT NULL DEFAULT 'pending',
  -- BizDevWatchBaseline JSON (records keyed by recordId, establishedAt).
  "baseline_state"                      JSONB,
  "baselined_at"                        TIMESTAMPTZ(6),
  "last_attempt_at"                     TIMESTAMPTZ(6),
  "last_successful_complete_check_at"   TIMESTAMPTZ(6),
  "source_watermark"                    TIMESTAMPTZ(6),
  "last_error"                          TEXT,
  "consecutive_failures"                INTEGER NOT NULL DEFAULT 0,
  -- DB-only evaluator lease (tenant-scoped): claim token + expiry. A task
  -- claims a row by overwriting (lease_token, lease_until) atomically; both
  -- NULL when unclaimed. This creates NO schedule — the evaluator that
  -- already ticks claims work through it.
  "lease_token"                         VARCHAR(64),
  "lease_until"                         TIMESTAMPTZ(6),
  "created_at"                          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_watch_source_states_pkey" PRIMARY KEY ("id"),
  -- One state row per (tenant, watch, source family).
  CONSTRAINT "business_development_watch_source_states_watch_source_key"
    UNIQUE ("tenant_id", "watch_id", "source_family"),
  CONSTRAINT "business_development_watch_source_states_source_family_check"
    CHECK ("source_family" IN (
      'federal_award', 'federal_assistance_award', 'sam_opportunity',
      'tango_resource', 'lda_filing', 'acquisition_revision'
    )),
  CONSTRAINT "business_development_watch_source_states_health_check"
    CHECK ("health" IN ('pending', 'healthy', 'partial', 'error', 'stale', 'paused')),
  CONSTRAINT "business_development_watch_source_states_consecutive_failures_check"
    CHECK ("consecutive_failures" >= 0),
  -- A row is either unleased or has both token and expiry.
  CONSTRAINT "business_development_watch_source_states_lease_shape_check"
    CHECK (("lease_token" IS NULL AND "lease_until" IS NULL)
        OR ("lease_token" IS NOT NULL AND "lease_until" IS NOT NULL)),
  -- Baselined means a baseline JSON exists (and vice versa). baselined_at
  -- NULL = quiet baseline not yet run; the runner fills both together.
  CONSTRAINT "business_development_watch_source_states_baseline_shape_check"
    CHECK (("baselined_at" IS NULL AND "baseline_state" IS NULL)
        OR ("baselined_at" IS NOT NULL AND "baseline_state" IS NOT NULL)),
  -- A lease expiry is always in the future relative to when it was written;
  -- this is a sanity bound on claim writes, not a scheduling mechanism.
  CONSTRAINT "business_development_watch_source_states_lease_order_check"
    CHECK ("lease_until" IS NULL OR "lease_until" > "updated_at"),
  CONSTRAINT "business_development_watch_source_states_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Tenant-safe watch link: the composite FK guarantees the watch belongs
  -- to the SAME tenant. CASCADE: state dies with its watch.
  CONSTRAINT "business_development_watch_source_states_watch_fkey"
    FOREIGN KEY ("tenant_id", "watch_id")
    REFERENCES "business_development_watches"("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "business_development_watch_source_states_tenant_claim_idx"
  ON "business_development_watch_source_states"(
    "tenant_id", "source_family", "health", "lease_until");
CREATE INDEX "business_development_watch_source_states_last_success_idx"
  ON "business_development_watch_source_states"(
    "tenant_id", "last_successful_complete_check_at" DESC);

-- ── 3. Append-only tenant alerts ──────────────────────────────────────────

CREATE TABLE "business_development_alerts" (
  "id"                    UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"             UUID NOT NULL,
  "watch_id"              UUID NOT NULL,
  -- Denormalized prospect id for inbox queries without a join; kept exact
  -- by the tenant-safe composite FKs (watch and prospect of the same tenant).
  "prospect_id"           UUID NOT NULL,
  "source_family"         VARCHAR(32) NOT NULL,
  "category"              VARCHAR(32) NOT NULL,
  "change_kind"           VARCHAR(24) NOT NULL,
  "materiality"           VARCHAR(16) NOT NULL,
  "record_id"             TEXT NOT NULL,
  "source_revision"       TEXT,
  "fingerprint"           VARCHAR(64) NOT NULL,
  "dedupe_key"            VARCHAR(512) NOT NULL,
  "before_state"          JSONB,
  "after_state"           JSONB NOT NULL,
  "changes_jsonb"         JSONB NOT NULL DEFAULT '[]'::jsonb,
  "title"                 TEXT NOT NULL,
  "summary"               TEXT NOT NULL,
  -- INFERENCE text from the pure diff — never a source fact.
  "implication"           TEXT NOT NULL,
  "source_locator"        TEXT NOT NULL,
  "event_at"              TIMESTAMPTZ(6),
  "effective_at"           TIMESTAMPTZ(6),
  "published_at"           TIMESTAMPTZ(6),
  "first_observed_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- NOTE: recipient read/dismiss state is NOT stored here. The per-recipient
  -- business_development_alert_deliveries row is the SINGLE AUTHORITATIVE
  -- source of read/dismiss truth (one delivery per recipient per channel).
  "review_state"          VARCHAR(16) NOT NULL DEFAULT 'open',
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_alerts_pkey" PRIMARY KEY ("id"),
  -- FK-target criterion for the delivery composite FK below.
  CONSTRAINT "business_development_alerts_tenant_id_id_key"
    UNIQUE ("tenant_id", "id"),
  -- SEMANTIC unique: the same change can never be recorded twice per watch.
  CONSTRAINT "business_development_alerts_tenant_watch_dedupe_key"
    UNIQUE ("tenant_id", "watch_id", "dedupe_key"),
  CONSTRAINT "business_development_alerts_source_family_check"
    CHECK ("source_family" IN (
      'federal_award', 'federal_assistance_award', 'sam_opportunity',
      'tango_resource', 'lda_filing', 'acquisition_revision'
    )),
  CONSTRAINT "business_development_alerts_category_check"
    CHECK ("category" IN (
      'contract_award', 'assistance_award', 'opportunity', 'lobbying',
      'acquisition', 'entity_change', 'other'
    )),
  CONSTRAINT "business_development_alerts_change_kind_check"
    CHECK ("change_kind" IN ('new_record', 'material_update', 'correction', 'backfill')),
  CONSTRAINT "business_development_alerts_materiality_check"
    CHECK ("materiality" IN ('high', 'medium', 'low')),
  CONSTRAINT "business_development_alerts_review_state_check"
    CHECK ("review_state" IN ('open', 'review', 'suppressed')),
  -- Finite-string sanity: fingerprints are lower-case hex SHA-256.
  CONSTRAINT "business_development_alerts_fingerprint_check"
    CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "business_development_alerts_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Tenant-safe watch link: the composite FK guarantees the watch (and thus
  -- the prospect) belongs to the SAME tenant. CASCADE: alerts die with their
  -- watch; the watch dies with its prospect.
  CONSTRAINT "business_development_alerts_watch_fkey"
    FOREIGN KEY ("tenant_id", "watch_id")
    REFERENCES "business_development_watches"("tenant_id", "id") ON DELETE CASCADE,
  -- Tenant-safe prospect link for the DENORMALIZED prospect_id: the composite
  -- FK guarantees alert.prospect_id can never name a prospect of another
  -- tenant (the (tenant_id, id) unique index already exists on prospects
  -- since Phase 4).
  CONSTRAINT "business_development_alerts_prospect_fkey"
    FOREIGN KEY ("tenant_id", "prospect_id")
    REFERENCES "business_development_prospects"("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "business_development_alerts_tenant_watch_observed_idx"
  ON "business_development_alerts"("tenant_id", "watch_id", "first_observed_at" DESC);
CREATE INDEX "business_development_alerts_tenant_review_state_idx"
  ON "business_development_alerts"("tenant_id", "review_state", "first_observed_at" DESC);
CREATE INDEX "business_development_alerts_tenant_category_idx"
  ON "business_development_alerts"("tenant_id", "category", "first_observed_at" DESC);
CREATE INDEX "business_development_alerts_tenant_prospect_idx"
  ON "business_development_alerts"("tenant_id", "prospect_id", "first_observed_at" DESC);

-- ── 4. Idempotent in-app deliveries ───────────────────────────────────────

CREATE TABLE "business_development_alert_deliveries" (
  "id"                 UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"          UUID NOT NULL,
  "alert_id"           UUID NOT NULL,
  -- PLAIN UUID, no DB foreign key (same rationale as watch owners).
  "recipient_user_id"  UUID NOT NULL,
  "channel"            VARCHAR(16) NOT NULL DEFAULT 'in_app',
  "delivered_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- AUTHORITATIVE recipient read/dismiss state: this row — not the alert —
  -- is the single source of truth for whether THIS recipient has read or
  -- dismissed the alert on this channel.
  "read_at"            TIMESTAMPTZ(6),
  "dismissed_at"       TIMESTAMPTZ(6),
  -- PLAIN UUID, no DB FK (same rationale as watch owners): history survives
  -- user departure.
  "dismissed_by_user_id" UUID,

  CONSTRAINT "business_development_alert_deliveries_pkey" PRIMARY KEY ("id"),
  -- Idempotent delivery: same alert to the same recipient exactly once per
  -- channel, even across overlapping evaluator tasks.
  CONSTRAINT "business_development_alert_deliveries_recipient_channel_key"
    UNIQUE ("tenant_id", "alert_id", "recipient_user_id", "channel"),
  CONSTRAINT "business_development_alert_deliveries_channel_check"
    CHECK ("channel" IN ('in_app', 'digest')),
  -- Read/dismiss shape: a timestamp implies its actor and vice versa. A
  -- dismissal always implies a prior read.
  CONSTRAINT "business_development_alert_deliveries_read_shape_check"
    CHECK ("dismissed_at" IS NULL
        OR ("read_at" IS NOT NULL AND "dismissed_at" >= "read_at")),
  CONSTRAINT "business_development_alert_deliveries_dismiss_shape_check"
    CHECK (("dismissed_at" IS NULL AND "dismissed_by_user_id" IS NULL)
        OR ("dismissed_at" IS NOT NULL AND "dismissed_by_user_id" IS NOT NULL)),
  CONSTRAINT "business_development_alert_deliveries_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Tenant-safe alert link: the composite FK guarantees the alert belongs
  -- to the SAME tenant. CASCADE: deliveries die with their alert.
  CONSTRAINT "business_development_alert_deliveries_alert_fkey"
    FOREIGN KEY ("tenant_id", "alert_id")
    REFERENCES "business_development_alerts"("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "business_development_alert_deliveries_tenant_recipient_idx"
  ON "business_development_alert_deliveries"(
    "tenant_id", "recipient_user_id", "delivered_at" DESC);

-- ── 5. Row-level security (defense in depth, matching Phases 1–4) ─────────

ALTER TABLE "business_development_watches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_watches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_watches_isolation" ON "business_development_watches"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "business_development_watch_source_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_watch_source_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_watch_source_states_isolation"
  ON "business_development_watch_source_states"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "business_development_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_alerts_isolation" ON "business_development_alerts"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "business_development_alert_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_alert_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_alert_deliveries_isolation"
  ON "business_development_alert_deliveries"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── 6. Grants (guarded, matching Phase 1/3/4) ─────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "business_development_watches" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "business_development_watch_source_states" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "business_development_alerts" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "business_development_alert_deliveries" TO capiro_app;
  END IF;
END
$$;

-- ── 7. Quiet backfill: one ACTIVE watch per existing watch_requested
--      prospect, baselined_at NULL. The runner creates the baseline WITHOUT
--      manufacturing alerts. This step writes ZERO alert rows by design.
--      Idempotent: the (tenant, prospect) unique makes a re-run a no-op.

INSERT INTO "business_development_watches" (
  "id", "tenant_id", "prospect_id", "owner_user_id", "status",
  "categories", "digest", "preference_version", "requested_by_user_id"
)
SELECT
  uuid_generate_v4(),
  p."tenant_id",
  p."id",
  p."owner_user_id",
  'active',
  '{}'::text[],
  false,
  1,
  p."created_by_user_id"
FROM "business_development_prospects" p
WHERE p."watch_requested" = true
ON CONFLICT ("tenant_id", "prospect_id") DO NOTHING;

-- Backfilled watches also need evaluator state or they can never be claimed.
-- Seed only families whose existing projections have a defensible linkage in
-- the Phase 5 evaluator. acquisition_revision is deliberately omitted until
-- its existing ledger can prove an exact prospect identity key; no fuzzy
-- company-name link is manufactured here.
INSERT INTO "business_development_watch_source_states" (
  "id", "tenant_id", "watch_id", "source_family", "health"
)
SELECT
  uuid_generate_v4(),
  w."tenant_id",
  w."id",
  source."source_family",
  'pending'
FROM "business_development_watches" w
CROSS JOIN (VALUES
  ('federal_award'),
  ('federal_assistance_award'),
  ('sam_opportunity'),
  ('tango_resource'),
  ('lda_filing')
) AS source("source_family")
WHERE EXISTS (
  SELECT 1
  FROM "business_development_prospects" p
  WHERE p."tenant_id" = w."tenant_id"
    AND p."id" = w."prospect_id"
    AND p."watch_requested" = true
)
ON CONFLICT ("tenant_id", "watch_id", "source_family") DO NOTHING;
