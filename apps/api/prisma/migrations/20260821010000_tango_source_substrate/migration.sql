-- P15 — MakeGov/Tango snapshot, crosswalk, checkpoint, and usage substrate.
--
-- WHAT THIS DOES
-- --------------
-- Creates four brand-new, ADDITIVE tables. Nothing existing is touched: no
-- ALTER on any table this repository already owns, no column added anywhere
-- else, no data moved.
--
-- WHY THESE FOUR TABLES CARRY NO tenant_id AND NO RLS
-- ----------------------------------------------------
-- A Tango observation of an entity, opportunity, forecast or vehicle is a fact
-- about the FEDERAL MARKETPLACE, not about any one tenant — exactly like the
-- `federal_grant` and `sam_opportunity` tables this schema already treats as
-- global reference data with no RLS. `PrismaService.tenantScopedModels` derives
-- its enforcement set by scanning the schema for a `tenantId` field, so omitting
-- it here is what keeps a plain `this.prisma.tangoResourceSnapshot.*` call
-- correctly UNFLAGGED by tenant-scope-guard.spec.ts — there is no tenant
-- dimension for that guard to protect.
--
-- NO CODE PATH WRITES TO THESE TABLES YET
-- ----------------------------------------
-- `tango-store.service.ts` (this phase) is fully implemented and fully tested,
-- but nothing calls it. `funding_opportunities_tango_shadow` — the flag that
-- will eventually gate the sync jobs that DO call it — is not read by anything
-- this migration touches, and stays off. Applying this migration changes
-- nothing about what any tenant sees.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS or DROP-then-ADD, so a
-- half-applied run can be re-applied cleanly. A failed migration blocks every
-- later one, which is why that matters more than it looks.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. tango_resource_snapshot — append-only, versioned-head observations.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tango_resource_snapshot" (
    "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
    "resource_type"        VARCHAR(32) NOT NULL,
    "external_id"          TEXT NOT NULL,
    "schema_version"       INTEGER NOT NULL DEFAULT 1,
    "source_updated_at"    TIMESTAMPTZ(6),
    "provider_fetched_at"  TIMESTAMPTZ(6) NOT NULL,
    "source_url"           TEXT,
    "content_sha256"       VARCHAR(64) NOT NULL,
    "normalized_jsonb"     JSONB NOT NULL,
    "active"               BOOLEAN NOT NULL DEFAULT true,
    "version"              INTEGER NOT NULL DEFAULT 1,
    "superseded_at"        TIMESTAMPTZ(6),
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tango_resource_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tango_resource_snapshot_resource_type_chk"
        CHECK ("resource_type" IN ('entity', 'opportunity', 'notice', 'forecast', 'vehicle', 'vehicle_awardee')),
    -- Lower-case hex-64. A short, malformed, or upper-case hash is refused rather
    -- than silently stored as something the natural-key lookup will never match
    -- again — which would defeat duplicate suppression on every subsequent sync.
    CONSTRAINT "tango_resource_snapshot_hash_chk"
        CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "tango_resource_snapshot_version_chk"
        CHECK ("version" >= 1),
    CONSTRAINT "tango_resource_snapshot_schema_version_chk"
        CHECK ("schema_version" >= 1),
    -- The versioned-head invariant, stated as data: an ACTIVE row has never been
    -- superseded, and a SUPERSEDED row always carries the timestamp of when.
    CONSTRAINT "tango_resource_snapshot_active_consistency_chk"
        CHECK (
            ("active" = true  AND "superseded_at" IS NULL)
            OR
            ("active" = false AND "superseded_at" IS NOT NULL)
        )
);

-- The natural key: the SAME exact content can never be stored twice for the same
-- resource. This is the exact predicate writeSnapshot() checks before deciding
-- whether an observation is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_resource_snapshot_natural_key_uniq"
    ON "tango_resource_snapshot" ("resource_type", "external_id", "content_sha256");

-- The versioned-head constraint AS a partial unique index, not just application
-- discipline: at most one row per (resource_type, external_id) may be active.
-- Postgres would otherwise let a bug in writeSnapshot() leave two heads active at
-- once, silently, with no error from the database that is supposed to prevent it.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_resource_snapshot_one_active_uniq"
    ON "tango_resource_snapshot" ("resource_type", "external_id")
    WHERE "active" = true;

-- History lookups: every observation of one resource, oldest first.
CREATE INDEX IF NOT EXISTS "tango_resource_snapshot_history_idx"
    ON "tango_resource_snapshot" ("resource_type", "external_id", "version");

-- NO RLS. This table is global reference data, the same category as
-- federal_grant / sam_opportunity, which carry none either.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. tango_resource_link — reviewed crosswalk, GLOBAL resources only.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tango_resource_link" (
    "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
    "local_resource_type"  VARCHAR(32) NOT NULL,
    "local_resource_id"    TEXT NOT NULL,
    "tango_resource_type"  VARCHAR(32) NOT NULL,
    "tango_external_id"    TEXT NOT NULL,
    "basis"                VARCHAR(24) NOT NULL,
    "status"               VARCHAR(16) NOT NULL DEFAULT 'active',
    "confidence_band"      VARCHAR(8) NOT NULL,
    "conflict_state"       VARCHAR(24) NOT NULL DEFAULT 'none',
    "reviewed_by"          UUID,
    "reviewed_at"          TIMESTAMPTZ(6),
    "review_notes"         TEXT,
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tango_resource_link_pkey" PRIMARY KEY ("id"),
    -- ONLY these four EXISTING global reference tables may be linked. A tenant
    -- resource (a client, a client_funding_opportunity row) is never valid here —
    -- linking tenant data into a table with no RLS would be exactly the leak
    -- class RLS exists to prevent, just via a table that has none.
    CONSTRAINT "tango_resource_link_local_type_chk"
        CHECK ("local_resource_type" IN ('sam_opportunity', 'federal_grant', 'federal_contractor', 'federal_award')),
    CONSTRAINT "tango_resource_link_tango_type_chk"
        CHECK ("tango_resource_type" IN ('entity', 'opportunity', 'notice', 'forecast', 'vehicle', 'vehicle_awardee')),
    -- Never a fuzzy name match. Same invariant P02 enforced for award-history
    -- identity, applied here to the Tango↔Capiro crosswalk.
    CONSTRAINT "tango_resource_link_basis_chk"
        CHECK ("basis" IN ('exact_identifier', 'reviewed_manual')),
    CONSTRAINT "tango_resource_link_status_chk"
        CHECK ("status" IN ('active', 'rejected', 'superseded')),
    CONSTRAINT "tango_resource_link_confidence_chk"
        CHECK ("confidence_band" IN ('high', 'medium', 'low')),
    CONSTRAINT "tango_resource_link_conflict_chk"
        CHECK ("conflict_state" IN ('none', 'field_conflict', 'identity_conflict')),
    -- A REJECTION is durable: it always carries who and when, the same
    -- actor+timestamp pairing rule as P07's human-decision columns. Both
    -- guarded with IS NOT NULL before the equality per D-18's three-valued-logic
    -- lesson from P13 — `status = 'rejected'` alone is NULL, not FALSE, for a
    -- NULL status, and this CHECK must actually reject that row.
    CONSTRAINT "tango_resource_link_rejection_actor_chk"
        CHECK (
            ("status" IS NOT NULL AND "status" <> 'rejected')
            OR
            ("status" = 'rejected' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
        )
);

-- One link row per pair. Re-proposing the same pair finds this row instead of
-- creating a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_resource_link_pair_uniq"
    ON "tango_resource_link" ("local_resource_type", "local_resource_id", "tango_resource_type", "tango_external_id");

CREATE INDEX IF NOT EXISTS "tango_resource_link_tango_idx"
    ON "tango_resource_link" ("tango_resource_type", "tango_external_id");

-- NO RLS. Both sides of every link are global data; nothing tenant-scoped can
-- ever appear in this table, enforced by the CHECK above.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. tango_sync_checkpoint — resumable provider-side pagination state.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tango_sync_checkpoint" (
    "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
    "sync_verb"            VARCHAR(64) NOT NULL,
    "resource_type"        VARCHAR(32) NOT NULL,
    "filter_fingerprint"   VARCHAR(64) NOT NULL,
    "cursor"               TEXT,
    "window_start"         TIMESTAMPTZ(6),
    "window_end"           TIMESTAMPTZ(6),
    "completeness"         VARCHAR(16) NOT NULL DEFAULT 'in_progress',
    "rows_processed"       INTEGER NOT NULL DEFAULT 0,
    "last_run_at"          TIMESTAMPTZ(6),
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tango_sync_checkpoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tango_sync_checkpoint_resource_type_chk"
        CHECK ("resource_type" IN ('entity', 'opportunity', 'notice', 'forecast', 'vehicle', 'vehicle_awardee')),
    -- Same hex-64 shape as the snapshot's content hash, and for the same reason:
    -- a malformed fingerprint would silently stop matching itself on every
    -- subsequent run, which turns "resume" into "restart from scratch" quietly.
    CONSTRAINT "tango_sync_checkpoint_fingerprint_chk"
        CHECK ("filter_fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "tango_sync_checkpoint_completeness_chk"
        CHECK ("completeness" IN ('in_progress', 'complete', 'incomplete')),
    CONSTRAINT "tango_sync_checkpoint_rows_chk"
        CHECK ("rows_processed" >= 0),
    -- A window, if stated, must not end before it starts.
    CONSTRAINT "tango_sync_checkpoint_window_chk"
        CHECK ("window_start" IS NULL OR "window_end" IS NULL OR "window_start" <= "window_end")
);

-- ONE checkpoint per (verb, resource, filter combination). Same filters resume
-- the same walk; different filters get an independent one.
CREATE UNIQUE INDEX IF NOT EXISTS "tango_sync_checkpoint_walk_uniq"
    ON "tango_sync_checkpoint" ("sync_verb", "resource_type", "filter_fingerprint");

-- NO RLS. This checkpoint tracks Tango's OWN global pagination, not a tenant's
-- progress through anything.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. tango_api_usage — account-level call accounting. NEVER headers or keys.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tango_api_usage" (
    "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
    "call_family"            VARCHAR(64) NOT NULL,
    "timestamp_bucket"       TIMESTAMPTZ(6) NOT NULL,
    "status"                 VARCHAR(16) NOT NULL,
    "row_count"              INTEGER,
    "rate_limit_remaining"   INTEGER,
    "rate_limit_limit"       INTEGER,
    "rate_limit_reset_in"    INTEGER,
    "duration_ms"            INTEGER NOT NULL,
    "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tango_api_usage_pkey" PRIMARY KEY ("id"),
    -- 'success' plus TangoErrorKind's 7 values (tango.errors.ts, P14) — the exact
    -- same vocabulary, so a usage row's status is always one this program already
    -- knows how to reason about. No column here can hold a header or a key: there
    -- is deliberately no column for either.
    CONSTRAINT "tango_api_usage_status_chk"
        CHECK ("status" IN ('success', 'auth', 'tier', 'validation', 'not_found', 'rate_limit', 'transient', 'permanent')),
    CONSTRAINT "tango_api_usage_row_count_chk"
        CHECK ("row_count" IS NULL OR "row_count" >= 0),
    CONSTRAINT "tango_api_usage_duration_chk"
        CHECK ("duration_ms" >= 0),
    CONSTRAINT "tango_api_usage_rate_remaining_chk"
        CHECK ("rate_limit_remaining" IS NULL OR "rate_limit_remaining" >= 0)
);

-- Time-ordered scan for "usage in the last N minutes" — what a rate-ceiling check
-- and a health dashboard both need.
CREATE INDEX IF NOT EXISTS "tango_api_usage_family_time_idx"
    ON "tango_api_usage" ("call_family", "timestamp_bucket");

-- NO RLS. Provider call accounting is a fact about Capiro's OWN account with
-- MakeGov, not about any tenant.
