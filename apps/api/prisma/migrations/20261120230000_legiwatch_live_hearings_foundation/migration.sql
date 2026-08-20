-- LegiWatch Live Hearings — canonical discovery + global capture foundation.
--
-- WHY
-- Today's live-hearing capture (intel-api's LiveHearingSession/TranscriptSegment
-- + the Deepgram WS gateway) is one process per tenant session, even when N
-- tenants are watching the same public congressional hearing. This migration
-- adds the GLOBAL layer needed to capture a public hearing exactly once and
-- fan it out to many tenant subscribers: discovery (committee_source →
-- hearing_source_observation → committee_hearing reconciliation →
-- hearing_stream_candidate) and capture (public_hearing_capture[_attempt] →
-- public_hearing_transcript_segment). It does not touch, replace, or migrate
-- data out of the existing intel-api browser-capture path — that stays as-is.
--
-- ADDITIVE, FORWARD-ONLY, NO DATA MIGRATION.
-- committee_hearing gains only new NULL/defaulted columns; every other table
-- here is brand new. Existing rows, indexes, and read paths are untouched.
--
-- TENANCY POSTURE
-- committee_hearing, committee_source, hearing_source_observation,
-- hearing_stream_candidate, public_hearing_capture[_attempt],
-- public_hearing_transcript_segment, and committee_site_update are GLOBAL
-- public-record tables: no tenant_id, no RLS — same posture as
-- committee_hearing today. Only hearing_subscription and
-- hearing_auto_record_rule below are TENANT-scoped, mirroring the
-- congress_bill → tracked_bill split (tenant_id + FK to tenants(id) ON DELETE
-- CASCADE + the canonical rls_bypass() OR tenant_id = current_tenant_id()
-- policy). Cross-references into the global layer (hearing_id) stay SOFT
-- refs, exactly like tracked_bill.bill_id.

-- ============================================================================
-- 1. committee_hearing — canonical master-calendar identity (additive)
-- ============================================================================

ALTER TABLE "committee_hearing"
  ADD COLUMN IF NOT EXISTS "congress" INTEGER,
  ADD COLUMN IF NOT EXISTS "committee_system_code" TEXT,
  ADD COLUMN IF NOT EXISTS "subcommittee_system_code" TEXT,
  ADD COLUMN IF NOT EXISTS "actual_start" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "actual_end" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS "event_status" TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS "source_revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "last_official_update_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "stream_availability" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "coverage_status" TEXT NOT NULL DEFAULT 'not_covered';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'committee_hearing_visibility_chk') THEN
    ALTER TABLE "committee_hearing"
      ADD CONSTRAINT committee_hearing_visibility_chk
      CHECK ("visibility" IN ('public', 'private'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'committee_hearing_event_status_chk') THEN
    ALTER TABLE "committee_hearing"
      ADD CONSTRAINT committee_hearing_event_status_chk
      CHECK ("event_status" IN ('scheduled', 'postponed', 'canceled', 'in_progress', 'completed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'committee_hearing_stream_availability_chk') THEN
    ALTER TABLE "committee_hearing"
      ADD CONSTRAINT committee_hearing_stream_availability_chk
      CHECK ("stream_availability" IN ('unknown', 'none', 'live_only', 'archived', 'embedded_third_party'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'committee_hearing_coverage_status_chk') THEN
    ALTER TABLE "committee_hearing"
      ADD CONSTRAINT committee_hearing_coverage_status_chk
      CHECK ("coverage_status" IN ('not_covered', 'discovered', 'stream_ready', 'capturing', 'captured', 'no_public_stream', 'blocked'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "committee_hearing_committee_system_code_idx" ON "committee_hearing" ("committee_system_code");
CREATE INDEX IF NOT EXISTS "committee_hearing_coverage_status_idx" ON "committee_hearing" ("coverage_status");
CREATE INDEX IF NOT EXISTS "committee_hearing_event_status_idx" ON "committee_hearing" ("event_status");

-- ============================================================================
-- 2. committee_source — global registry of official per-committee/per-chamber
--    data sources that Phase 3's discovery adapters poll.
-- ============================================================================

CREATE TABLE "committee_source" (
    "id" TEXT NOT NULL,
    "committee_system_code" TEXT,
    "chamber" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "adapter_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "last_checked_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_error_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "source_health" TEXT NOT NULL DEFAULT 'unknown',
    "parser_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "committee_source_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "committee_source_chamber_chk" CHECK ("chamber" IN ('house', 'senate', 'joint')),
    CONSTRAINT "committee_source_source_type_chk" CHECK ("source_type" IN (
      'CONGRESS_GOV', 'HOUSE_REPOSITORY', 'SENATE_SCHEDULE', 'COMMITTEE_SITE',
      'COMMITTEE_RSS', 'COMMITTEE_API', 'COMMITTEE_STRUCTURED_DATA', 'COMMITTEE_HEADLESS'
    )),
    CONSTRAINT "committee_source_source_health_chk" CHECK ("source_health" IN ('healthy', 'degraded', 'failing', 'unknown'))
);

CREATE UNIQUE INDEX "committee_source_adapter_key_source_url_key" ON "committee_source" ("adapter_key", "source_url");
CREATE INDEX "committee_source_chamber_idx" ON "committee_source" ("chamber");
CREATE INDEX "committee_source_committee_system_code_idx" ON "committee_source" ("committee_system_code");
CREATE INDEX "committee_source_source_type_idx" ON "committee_source" ("source_type");
CREATE INDEX "committee_source_enabled_priority_idx" ON "committee_source" ("enabled", "priority");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "committee_source" TO capiro_app;
  END IF;
END
$$;

-- ============================================================================
-- 3. hearing_source_observation — provenance ledger, never overwritten.
-- ============================================================================

CREATE TABLE "hearing_source_observation" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT,
    "source_id" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "raw_content_hash" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "source_updated_at" TIMESTAMPTZ(6),
    "source_metadata" JSONB NOT NULL DEFAULT '{}',
    "observed_title" TEXT,
    "observed_date" DATE,
    "observed_status" TEXT,
    "observed_location" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "hearing_source_observation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hearing_source_observation_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "committee_source"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "hearing_source_observation_source_id_external_event_id_key" ON "hearing_source_observation" ("source_id", "external_event_id");
CREATE INDEX "hearing_source_observation_hearing_id_idx" ON "hearing_source_observation" ("hearing_id");
CREATE INDEX "hearing_source_observation_raw_content_hash_idx" ON "hearing_source_observation" ("raw_content_hash");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "hearing_source_observation" TO capiro_app;
  END IF;
END
$$;

-- ============================================================================
-- 4. hearing_stream_candidate — page provenance kept separate from media-host
--    provenance; a .gov page is not proof of first-party video transport.
-- ============================================================================

CREATE TABLE "hearing_stream_candidate" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "official_page_url" TEXT NOT NULL,
    "media_url" TEXT,
    "media_type" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "resolution_state" TEXT NOT NULL DEFAULT 'NOT_CHECKED',
    "capture_policy" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "source_id" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_probe_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "hearing_stream_candidate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hearing_stream_candidate_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "committee_source"("id") ON DELETE SET NULL,
    CONSTRAINT "hearing_stream_candidate_resolution_state_chk" CHECK ("resolution_state" IN (
      'NOT_CHECKED', 'WAITING_FOR_STREAM', 'READY', 'LIVE', 'ENDED',
      'NO_PUBLIC_STREAM', 'POLICY_BLOCKED', 'SOURCE_ERROR'
    )),
    CONSTRAINT "hearing_stream_candidate_capture_policy_chk" CHECK ("capture_policy" IN (
      'SERVER_CAPTURE_ALLOWED', 'BROWSER_CAPTURE_ONLY', 'LICENSE_REQUIRED', 'BLOCKED', 'REVIEW_REQUIRED'
    ))
);

CREATE INDEX "hearing_stream_candidate_hearing_id_priority_idx" ON "hearing_stream_candidate" ("hearing_id", "priority");
CREATE INDEX "hearing_stream_candidate_resolution_state_idx" ON "hearing_stream_candidate" ("resolution_state");
CREATE INDEX "hearing_stream_candidate_capture_policy_idx" ON "hearing_stream_candidate" ("capture_policy");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "hearing_stream_candidate" TO capiro_app;
  END IF;
END
$$;

-- ============================================================================
-- 5. public_hearing_capture — exactly one canonical capture per hearing,
--    enforced by the UNIQUE constraint on hearing_id (not by app discipline).
-- ============================================================================

CREATE TABLE "public_hearing_capture" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "selected_stream_candidate_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduled_start" TIMESTAMPTZ(6),
    "actual_start" TIMESTAMPTZ(6),
    "actual_end" TIMESTAMPTZ(6),
    "worker_lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "deepgram_session_ref" TEXT,
    "reconnect_count" INTEGER NOT NULL DEFAULT 0,
    "captured_seconds" INTEGER NOT NULL DEFAULT 0,
    "transcript_gap_seconds" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "public_hearing_capture_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "public_hearing_capture_status_chk" CHECK ("status" IN (
      'scheduled', 'leased', 'capturing', 'paused', 'ended', 'failed', 'no_stream'
    ))
);

-- THE invariant: one canonical capture per hearing, enforced by Postgres.
CREATE UNIQUE INDEX "public_hearing_capture_hearing_id_key" ON "public_hearing_capture" ("hearing_id");
CREATE INDEX "public_hearing_capture_status_idx" ON "public_hearing_capture" ("status");
CREATE INDEX "public_hearing_capture_worker_lease_owner_idx" ON "public_hearing_capture" ("worker_lease_owner");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "public_hearing_capture" TO capiro_app;
  END IF;
END
$$;

-- ============================================================================
-- 6. public_hearing_capture_attempt — append-only retry/reconnect history.
-- ============================================================================

CREATE TABLE "public_hearing_capture_attempt" (
    "id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "worker_lease_owner" TEXT,
    "deepgram_session_ref" TEXT,
    "outcome" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "public_hearing_capture_attempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "public_hearing_capture_attempt_capture_id_fkey"
      FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE,
    CONSTRAINT "public_hearing_capture_attempt_outcome_chk" CHECK (
      "outcome" IS NULL OR "outcome" IN ('succeeded', 'failed', 'superseded', 'timed_out')
    )
);

CREATE UNIQUE INDEX "public_hearing_capture_attempt_capture_id_attempt_number_key" ON "public_hearing_capture_attempt" ("capture_id", "attempt_number");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "public_hearing_capture_attempt" TO capiro_app;
  END IF;
END
$$;

-- ============================================================================
-- 7. public_hearing_transcript_segment — the ONE canonical live transcript
--    for a server-captured public hearing. Shape mirrors intel-api's
--    TranscriptSegment (start_ms/end_ms, is_final, speaker, confidence, the
--    (parent, start_ms, end_ms) idempotency key) minus per-tenant encryption —
--    this is public congressional-record text, not sensitive tenant data.
-- ============================================================================

CREATE TABLE "public_hearing_transcript_segment" (
    "id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "speaker_label" TEXT,
    "speaker_confidence" DOUBLE PRECISION,
    "transcription_confidence" DOUBLE PRECISION,
    "is_final" BOOLEAN NOT NULL DEFAULT true,
    "has_gap_before" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "public_hearing_transcript_segment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "public_hearing_transcript_segment_capture_id_fkey"
      FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE
);

-- Idempotency key: safely replay a resent final without duplicating it.
CREATE UNIQUE INDEX "public_hearing_transcript_segment_capture_id_start_ms_end_ms_key" ON "public_hearing_transcript_segment" ("capture_id", "start_ms", "end_ms");
CREATE INDEX "public_hearing_transcript_segment_capture_id_sequence_idx" ON "public_hearing_transcript_segment" ("capture_id", "sequence");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "public_hearing_transcript_segment" TO capiro_app;
  END IF;
END
$$;

-- ============================================================================
-- 8. committee_site_update — normalized change feed for future Committee
--    Rooms. Stores facts/hashes/diffs; never copies full page content.
-- ============================================================================

CREATE TABLE "committee_site_update" (
    "id" TEXT NOT NULL,
    "committee_system_code" TEXT NOT NULL,
    "hearing_id" TEXT,
    "update_type" TEXT NOT NULL,
    "normalized_title" TEXT NOT NULL,
    "normalized_summary" TEXT,
    "source_url" TEXT NOT NULL,
    "official_published_at" TIMESTAMPTZ(6),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "content_hash" TEXT NOT NULL,
    "previous_value" TEXT,
    "new_value" TEXT,
    "source_id" TEXT,
    "parser_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "committee_site_update_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "committee_site_update_source_id_fkey"
      FOREIGN KEY ("source_id") REFERENCES "committee_source"("id") ON DELETE SET NULL,
    CONSTRAINT "committee_site_update_update_type_chk" CHECK ("update_type" IN (
      'hearing_announced', 'date_changed', 'time_changed', 'room_changed', 'postponed', 'canceled',
      'witness_added', 'witness_removed', 'witness_testimony_published', 'committee_memo_published',
      'bill_added', 'amendment_added', 'livestream_posted', 'livestream_changed', 'archive_posted',
      'official_transcript_posted'
    ))
);

CREATE INDEX "committee_site_update_committee_system_code_last_seen_at_idx" ON "committee_site_update" ("committee_system_code", "last_seen_at");
CREATE INDEX "committee_site_update_hearing_id_idx" ON "committee_site_update" ("hearing_id");
CREATE INDEX "committee_site_update_update_type_idx" ON "committee_site_update" ("update_type");
CREATE INDEX "committee_site_update_content_hash_idx" ON "committee_site_update" ("content_hash");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "committee_site_update" TO capiro_app;
  END IF;
END
$$;

-- ============================================================================
-- 9. hearing_subscription — TENANT-scoped. Mirrors tracked_bill's split from
--    congress_bill: hearing_id is a SOFT ref into the global layer above.
-- ============================================================================

CREATE TABLE "hearing_subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "notify_on_start" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_mention" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_by_user" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_by_rule_id" TEXT,
    "client_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "watchlist_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "hearing_subscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hearing_subscription_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "hearing_subscription_tenant_id_user_id_hearing_id_key" ON "hearing_subscription" ("tenant_id", "user_id", "hearing_id");
CREATE INDEX "hearing_subscription_tenant_id_hearing_id_idx" ON "hearing_subscription" ("tenant_id", "hearing_id");
CREATE INDEX "hearing_subscription_hearing_id_idx" ON "hearing_subscription" ("hearing_id");

ALTER TABLE "hearing_subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hearing_subscription" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hearing_subscription_isolation" ON "hearing_subscription"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "hearing_subscription" TO capiro_app;
  END IF;
END
$$;

-- ============================================================================
-- 10. hearing_auto_record_rule — TENANT-scoped. Schema + contract only; the
--     matching engine is a later phase.
-- ============================================================================

CREATE TABLE "hearing_auto_record_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "committee_filters" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "subcommittee_filters" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "event_type_filters" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "keyword_filters" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "client_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "watchlist_id" TEXT,
    "public_only" BOOLEAN NOT NULL DEFAULT true,
    "notify_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "notify_in_app" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "hearing_auto_record_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hearing_auto_record_rule_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX "hearing_auto_record_rule_tenant_id_enabled_idx" ON "hearing_auto_record_rule" ("tenant_id", "enabled");

ALTER TABLE "hearing_auto_record_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hearing_auto_record_rule" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hearing_auto_record_rule_isolation" ON "hearing_auto_record_rule"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "hearing_auto_record_rule" TO capiro_app;
  END IF;
END
$$;
