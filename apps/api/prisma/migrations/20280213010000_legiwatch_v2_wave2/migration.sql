-- LegiWatch V2 Wave 2 — Saved Views (W2-2) and Watch Presets + backtest job
-- queue (W2-4).
--
-- Extends the Wave 1 tenant layer; creates no second hearing/capture/
-- transcript/intelligence/watchlist path. Watch Presets store an ENUMERATED
-- condition definition only — matching runs against the EXISTING canonical
-- tables this migration does not touch (committee_hearing, congress_bill,
-- federal_register_document, program_element_year) and the existing
-- tenant_hearing_relevance rail; there is no new alerting/matching engine and
-- no arbitrary expression language.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────
-- W2-2 — Saved Views.
--
-- `config` carries the surface-specific filter/search/sort/date-range/layout
-- state as a bounded, key-allowlisted JSON blob (app-level validation in
-- LegiWatchSaveViewDto — see legiwatch-wave2-saved-views.dto.ts for the
-- recursive bounds walker and the reserved-key rejection). `config_version`
-- is the shape version of that payload: a reader that does not understand a
-- stored version must refuse to apply it rather than guess, so a future
-- config-shape change cannot silently misapply old saved state.
--
-- `client_id` is pulled OUT of `config` into its own column specifically so
-- it can be validated (tenant ownership) and its liveness checked (an
-- archived/deleted client must produce an explicit warning on apply, never a
-- silent substitution) without parsing arbitrary JSON.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "legiwatch_saved_view" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  -- 'hearings_schedule' | 'hearings_archive' | 'committees' |
  -- 'committee_intelligence' | 'feed' | 'bills'
  "surface" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- 'personal' (default) | 'tenant' (readable by the whole tenant; still
  -- mutable ONLY by owner_user_id — sharing widens READ, never WRITE).
  "scope" TEXT NOT NULL DEFAULT 'personal',
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  -- soft ref -> clients.id; validated tenant-owned at write time.
  "client_id" UUID,
  "config_version" INTEGER NOT NULL DEFAULT 1,
  "config" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_saved_view_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_saved_view_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_saved_view_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL,
  CONSTRAINT "legiwatch_saved_view_surface_check"
    CHECK ("surface" IN (
      'hearings_schedule', 'hearings_archive', 'committees',
      'committee_intelligence', 'feed', 'bills'
    )),
  CONSTRAINT "legiwatch_saved_view_scope_check"
    CHECK ("scope" IN ('personal', 'tenant')),
  CONSTRAINT "legiwatch_saved_view_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 120),
  -- Defense-in-depth byte-size backstop. The real bound is app-level
  -- (LegiWatchSaveViewDto's recursive walker); this exists only so a future
  -- write path that bypasses the DTO cannot persist an unbounded blob.
  CONSTRAINT "legiwatch_saved_view_config_size_check"
    CHECK (octet_length("config"::text) <= 16384)
);

-- One default per (tenant, owner, surface). A view's owner is the only actor
-- who can default a view at all (see "Personal views cannot be mutated by
-- another user" — defaulting a shared view you don't own requires
-- duplicating it into your own personal copy first, same as any other edit).
CREATE UNIQUE INDEX IF NOT EXISTS "legiwatch_saved_view_one_default_per_owner_surface"
  ON "legiwatch_saved_view" ("tenant_id", "owner_user_id", "surface")
  WHERE "is_default" = true;

CREATE INDEX IF NOT EXISTS "legiwatch_saved_view_tenant_owner_surface_idx"
  ON "legiwatch_saved_view" ("tenant_id", "owner_user_id", "surface", "updated_at" DESC);
-- Backs the tenant-shared list query (scope='tenant', any owner) per surface.
CREATE INDEX IF NOT EXISTS "legiwatch_saved_view_tenant_shared_idx"
  ON "legiwatch_saved_view" ("tenant_id", "surface", "updated_at" DESC)
  WHERE "scope" = 'tenant';

ALTER TABLE "legiwatch_saved_view" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_saved_view" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- W2-4 — Watch presets.
--
-- A preset is a SUPPLEMENT to the canonical client watchlist, not a second
-- targeting/alerting store: it records an enumerated scope + signal-family +
-- trigger-condition definition for backtest preview and lifecycle management
-- (pause/resume/archive) here in apps/api, where the canonical HEARINGS/
-- BILLS/REGULATIONS/PROGRAM_ELEMENTS corpora already live. It does not
-- generate live alerts on its own and does not compete with intel-api's
-- Watchlist/Feed pipeline.
--
-- `signal_families` uses the SAME source-family vocabulary the shipped Feed
-- already speaks (`FeedSourceType` in apps/web/.../lib/types.ts: bill,
-- hearing, regulation, program_element, state_bill) rather than inventing a
-- parallel one that includes a standalone "funding" family — funding
-- movement is a real TRIGGER on program_element data, not a distinct source,
-- confirmed against the existing alert/detector model. `conditions` is a
-- CLOSED, enumerated array (CHECK below), never a free-form expression.
-- ─────────────────────────────────────────────────────────────────────────

-- A CHECK constraint cannot itself contain a subquery (Postgres 0A000), so the
-- "every element's type is in the closed vocabulary" validation is wrapped in
-- an IMMUTABLE function — a function call is a normal, allowed CHECK
-- expression even though its body contains one.
CREATE OR REPLACE FUNCTION legiwatch_watch_conditions_valid("conditions" JSONB)
  RETURNS BOOLEAN
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements("conditions") AS c
    WHERE (c->>'type') IS NULL
       OR (c->>'type') NOT IN (
         'KEYWORD_MATCH', 'STATUS_CHANGE', 'FUNDING_MOVEMENT',
         'HEARING_SCHEDULED', 'CLIENT_RELEVANCE_HIGH'
       )
  )
$$;

CREATE TABLE IF NOT EXISTS "legiwatch_watch_preset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- The clients this preset previews/applies for. Validated tenant-owned.
  "client_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "signal_families" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Array of {type, ...params} objects; `type` is CHECKed against the closed
  -- vocabulary below via a jsonb_array_elements EXISTS guard (Postgres CHECK
  -- cannot directly express "every element satisfies X", so the guard is a
  -- NOT EXISTS-of-violation form).
  "conditions" JSONB NOT NULL DEFAULT '[]',
  -- 'active' | 'paused' | 'archived'
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_watch_preset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_watch_preset_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_watch_preset_name_check"
    CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "legiwatch_watch_preset_status_check"
    CHECK ("status" IN ('active', 'paused', 'archived')),
  CONSTRAINT "legiwatch_watch_preset_families_check"
    CHECK (
      "signal_families" <@ ARRAY['bill','hearing','regulation','program_element','state_bill']::text[]
      AND array_length("signal_families", 1) > 0
    ),
  CONSTRAINT "legiwatch_watch_preset_conditions_array_check"
    CHECK (jsonb_typeof("conditions") = 'array'),
  CONSTRAINT "legiwatch_watch_preset_conditions_type_check"
    CHECK (legiwatch_watch_conditions_valid("conditions")),
  CONSTRAINT "legiwatch_watch_preset_conditions_size_check"
    CHECK (octet_length("conditions"::text) <= 16384)
);

CREATE INDEX IF NOT EXISTS "legiwatch_watch_preset_tenant_owner_idx"
  ON "legiwatch_watch_preset" ("tenant_id", "owner_user_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "legiwatch_watch_preset_tenant_status_idx"
  ON "legiwatch_watch_preset" ("tenant_id", "status");

ALTER TABLE "legiwatch_watch_preset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_watch_preset" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- W2-4 — backtest async-job queue.
--
-- Copies the shape of the shipped `public_hearing_intelligence_job` /
-- `tenant_hearing_relevance_job` lease tables verbatim (status enum,
-- attempts, due_at, lease_owner, lease_expires_at, last_error,
-- completed_at) rather than inventing a new queueing architecture. A
-- backtest is READ-ONLY by construction (it only ever produces a `result`
-- payload); no code path from this table may write to any other table.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "legiwatch_watch_backtest_job" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  -- Nullable: a backtest may preview a not-yet-saved draft preset.
  "preset_id" UUID,
  -- The exact request that was evaluated — the query being deterministic
  -- "for the same snapshot/query version" needs the literal request bound to
  -- the result, not just an ambient reference to a preset that could later
  -- change independently of this row.
  "request" JSONB NOT NULL,
  "query_version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'leased', 'completed', 'failed')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "due_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "result" JSONB,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_watch_backtest_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_watch_backtest_job_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_watch_backtest_job_preset_fk"
    FOREIGN KEY ("preset_id") REFERENCES "legiwatch_watch_preset"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_watch_backtest_job_lease_check"
    CHECK (("status" <> 'leased') OR ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
);

-- The claim index: mirrors public_hearing_intelligence_job_claim_idx exactly
-- (partial, over the three claimable statuses).
CREATE INDEX IF NOT EXISTS "legiwatch_watch_backtest_job_claim_idx"
  ON "legiwatch_watch_backtest_job" ("due_at" ASC, "created_at" ASC, "id" ASC)
  WHERE "status" IN ('pending', 'failed', 'leased');
CREATE INDEX IF NOT EXISTS "legiwatch_watch_backtest_job_tenant_owner_idx"
  ON "legiwatch_watch_backtest_job" ("tenant_id", "owner_user_id", "created_at" DESC);

ALTER TABLE "legiwatch_watch_backtest_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_watch_backtest_job" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- RLS policies — every table above is tenant-owned and FORCE-isolated.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  p TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'legiwatch_saved_view',
    'legiwatch_watch_preset',
    'legiwatch_watch_backtest_job'
  ]
  LOOP
    p := t || '_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = t
        AND policyname = p
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (rls_bypass() OR tenant_id = current_tenant_id()) '
        || 'WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())',
        p, t
      );
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_saved_view" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_watch_preset" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_watch_backtest_job" TO capiro_app;
  END IF;
END
$$;
