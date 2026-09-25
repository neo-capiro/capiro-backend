-- Business Development Phase 4 — prospect brief persistence.
--
-- Additive, tenant-private, rollback-safe. Two new tables:
--   business_development_briefs        one stable root artifact per (tenant,
--                                      prospect), carrying the current
--                                      version pointer;
--   business_development_brief_versions immutable append-only versions with
--                                      the exact five-section contract, the
--                                      source snapshot, citations, and
--                                      per-section provenance.
--
-- No existing row or table is changed except one additive redundant unique
-- index on business_development_prospects (tenant_id, id) that Prisma needs
-- to express the tenant-safe composite foreign key. Every new table gets the
-- standard RLS ENABLE + FORCE + isolation policy pair. A saved version is
-- NEVER mutated or deleted in normal operation; the app writes versions
-- insert-only and only ever updates the brief root.
--
-- Semantics this DDL enforces:
--   * One brief per (tenant, prospect) including archived rows — composite
--     unique; the service reuses the existing root.
--   * The brief↔prospect link is tenant-safe by a COMPOSITE foreign key on
--     (tenant_id, prospect_id) referencing the composite key of
--     business_development_prospects (tenant_id, id): a cross-tenant prospect
--     id can never be attached.
--   * Immutable versions: only SELECT and INSERT are granted on the version
--     table; the app never updates a version row. The idempotency unique
--     index (tenant_id, brief_id, idempotency_key) makes double-click/retry
--     return one logical result at the database level.
--   * current_version_id points WITHIN THE SAME BRIEF and tenant: the
--     composite FK (tenant_id, current_version_id, id) →
--     business_development_brief_versions (tenant_id, id, brief_id) checks
--     the pointed version belongs to THIS exact brief, not merely to any
--     brief of the tenant. A dangling or cross-brief pointer is impossible.
--     The app inserts the version first and sets the pointer in the same
--     transaction, so the constraint is checked at commit
--     (DEFERRABLE INITIALLY DEFERRED).

-- ── 0. Prisma-required composite key on prospects (additive, redundant) ────
-- (tenant_id, id) is functionally identical to the primary key (id is the
-- global PK), but Prisma can only express the tenant-safe composite FK below
-- against a declared unique criterion, and the DB benefits from an index that
-- keeps tenant-filtered lookups local to one tenant partition of the index.

CREATE UNIQUE INDEX IF NOT EXISTS "business_development_prospects_tenant_id_id_key"
  ON "business_development_prospects"("tenant_id", "id");

-- ── 1. Immutable brief versions (created FIRST: the brief FK points here) ──

CREATE TABLE "business_development_brief_versions" (
  "id"                  UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"           UUID NOT NULL,
  "brief_id"            UUID NOT NULL,
  -- Monotonic per brief; the service computes it under the prospect row lock.
  "version_number"      INTEGER NOT NULL,
  -- Exact five-section contract, validated shape-only server side:
  --   companyAndFirmImplication, verifiedEvidence, judgment,
  --   practicalAction, missingInformation
  -- plus per-section provenance (generated|edited) and citations.
  "sections"            JSONB NOT NULL,
  -- SHA-256 of the canonical sections JSON: deterministic content identity.
  "sections_hash"       VARCHAR(64) NOT NULL,
  -- Bounded immutable snapshot of the dossier evidence the version was built
  -- from (cited EvidenceItems only, plus generation metadata).
  "source_snapshot"     JSONB NOT NULL,
  "snapshot_hash"       VARCHAR(64) NOT NULL,
  -- Bounded citation list (≤12): each record preserves stable source identity
  -- and locator plus separated dates; missing dates stay NULL, never invented.
  "citations"           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- All writes are idempotent: (tenant, brief, key) unique — retry/double
  -- click returns the one logical saved version. The op + fingerprint
  -- columns are the discriminator: a saved key replays only for the SAME
  -- operation and content fingerprint; the service rejects anything else
  -- with an explicit conflict (a key is never reused silently).
  "idempotency_key"     VARCHAR(400) NOT NULL,
  -- Which write created this row: create | edit | accept.
  "idempotency_op"      VARCHAR(16) NOT NULL,
  -- SHA-256 content fingerprint of the attempted write at save time.
  "idempotency_fingerprint" VARCHAR(64) NOT NULL,
  "created_by_user_id"  UUID,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_brief_versions_pkey" PRIMARY KEY ("id"),
  -- FK-target criterion for the brief current-version pointer: the brief
  -- references (tenant_id, id, brief_id), so the pointed version must carry
  -- the SAME brief id as the referencing root — a cross-brief or
  -- cross-tenant pointer cannot satisfy it. PostgreSQL requires a unique
  -- index on exactly these columns; the constraint's own backing index
  -- (name business_development_brief_versions_tenant_id_id_brief_id_key)
  -- is also the physical index Prisma maps its @@unique criterion to.
  CONSTRAINT "business_development_brief_versions_tenant_id_id_brief_id_key"
    UNIQUE ("tenant_id", "id", "brief_id"),
  -- One row per (brief, version number): duplicate numbers are impossible
  -- even for concurrent writers (the unique index is the arbiter; the
  -- prospect row lock makes the common path clean).
  CONSTRAINT "business_development_brief_versions_brief_number_key"
    UNIQUE ("brief_id", "version_number"),
  CONSTRAINT "business_development_brief_versions_number_check"
    CHECK ("version_number" >= 1),
  CONSTRAINT "business_development_brief_versions_idempotency_op_check"
    CHECK ("idempotency_op" IN ('create', 'edit', 'accept')),
  CONSTRAINT "business_development_brief_versions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
  -- The version→brief FK is added AFTER the briefs table exists (see
  -- section 2): versions must be creatable in the same transaction as the
  -- brief root.
);

-- Standalone index for the idempotency criterion (not a table constraint:
-- (brief_id, idempotency_key) already implies uniqueness, this adds the
-- tenant-leading form for the service lookup). The unique CONSTRAINTs above
-- already created their backing indexes — none are re-declared here.
CREATE UNIQUE INDEX "business_development_brief_versions_tenant_idempotency_key"
  ON "business_development_brief_versions"("tenant_id", "brief_id", "idempotency_key");
CREATE INDEX "business_development_brief_versions_brief_created_idx"
  ON "business_development_brief_versions"("tenant_id", "brief_id", "created_at" DESC);

-- ── 2. Brief root (one per tenant+prospect) ────────────────────────────────

CREATE TABLE "business_development_briefs" (
  "id"                 UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"          UUID NOT NULL,
  "prospect_id"        UUID NOT NULL,
  -- Display title, bounded in the DTO (≤300 chars).
  "title"              TEXT NOT NULL,
  -- Lifecycle of the ROOT artifact (versions are immutable): draft while any
  -- saved version exists; archived is a soft terminal the UI can use.
  "status"             VARCHAR(16) NOT NULL DEFAULT 'draft',
  "current_version_id" UUID,
  "created_by_user_id" UUID,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_briefs_pkey" PRIMARY KEY ("id"),
  -- Composite key that the version→brief FK references. The SQL unique
  -- index with the same name is NOT re-created (the table constraint's
  -- own index backs it).
  CONSTRAINT "business_development_briefs_tenant_id_key"
    UNIQUE ("tenant_id", "id"),
  -- ONE brief per (tenant, prospect), archived roots included — the service
  -- reuses the existing root.
  CONSTRAINT "business_development_briefs_tenant_prospect_key"
    UNIQUE ("tenant_id", "prospect_id"),
  -- Prisma's one-to-one current-version relation uses these exact source
  -- fields. The target FK below also includes this brief id, so the pointer
  -- can only reference a version owned by this brief.
  CONSTRAINT "business_development_briefs_tenant_current_version_key"
    UNIQUE ("tenant_id", "current_version_id", "id"),
  CONSTRAINT "business_development_briefs_status_check"
    CHECK ("status" IN ('draft', 'archived')),
  CONSTRAINT "business_development_briefs_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Tenant-safe prospect link: the composite FK guarantees the prospect
  -- belongs to the SAME tenant. CASCADE mirrors prospect activity history.
  CONSTRAINT "business_development_briefs_prospect_fkey"
    FOREIGN KEY ("tenant_id", "prospect_id")
    REFERENCES "business_development_prospects"("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "business_development_briefs_tenant_updated_idx"
  ON "business_development_briefs"("tenant_id", "updated_at" DESC);

-- The version→brief cascade FK (tenant-safe composite). Added after both
-- tables exist; DEFERRABLE INITIALLY DEFERRED because the app inserts the
-- brief root and its first version in ONE transaction, each referencing the
-- other only at commit (root.current_version_id → version, version.brief_id
-- → root).
ALTER TABLE "business_development_brief_versions"
  ADD CONSTRAINT "business_development_brief_versions_brief_fkey"
  FOREIGN KEY ("tenant_id", "brief_id")
  REFERENCES "business_development_briefs"("tenant_id", "id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- The current-version pointer stays inside the SAME brief, same tenant, and
-- no other brief may point at the same version. The composite FK includes
-- the brief's OWN id: (tenant_id, current_version_id, id) must match a
-- version row with (tenant_id, id, brief_id) — i.e. the pointed version must
-- belong to THIS exact brief root. DEFERRABLE for the same single-transaction
-- create path as above.
ALTER TABLE "business_development_briefs"
  ADD CONSTRAINT "business_development_briefs_current_version_fkey"
  FOREIGN KEY ("tenant_id", "current_version_id", "id")
  REFERENCES "business_development_brief_versions"("tenant_id", "id", "brief_id")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- ── 3. Row-level security (defense in depth) ───────────────────────────────

ALTER TABLE "business_development_briefs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_briefs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_briefs_isolation" ON "business_development_briefs"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "business_development_brief_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_brief_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_brief_versions_isolation" ON "business_development_brief_versions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── 4. Grants (guarded, matching Phase 1/3) ────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "business_development_briefs" TO capiro_app;
    -- The role-wide default privileges grant UPDATE/DELETE on every newly
    -- created table. Remove those inherited capabilities explicitly so saved
    -- brief versions are append-only at the database boundary.
    REVOKE UPDATE, DELETE, TRUNCATE ON "business_development_brief_versions" FROM capiro_app;
    GRANT SELECT, INSERT ON "business_development_brief_versions" TO capiro_app;
  END IF;
END
$$;
