-- LegiWatch V2 Wave 1 — configurable follow/attend, committee follows, saved
-- references, lifecycle notification outbox, and archive search indexes.
--
-- This migration EXTENDS the canonical Live Hearings system. It deliberately
-- creates no second hearing, capture, transcript, or public-intelligence path:
--
--   one public hearing -> one canonical capture -> one canonical transcript
--   -> one canonical public intelligence layer -> many tenant layers
--
-- The Follow/Attend split established by Phase 7 is preserved and made
-- configurable, NOT merged:
--
--   hearing_follow        = notification interest only (never capture demand)
--   hearing_subscription  = capture demand, counted by the capture worker
--
-- Every tenant-owned table below is FORCE-RLS isolated on tenant_id, matching
-- hearing_follow / hearing_subscription. Hearing and committee references are
-- SOFT refs to the GLOBAL public-record tables (committee_hearing,
-- congress_committee) exactly as the existing tenant tables do.

-- ─────────────────────────────────────────────────────────────────────────
-- W1-1 — configurable hearing following.
--
-- Phase 7 shipped hearing_follow as a boolean interest toggle with two
-- notification flags. Wave 1 makes a follow client-scoped and gives it one
-- explicit flag per user-selectable notification category.
--
-- notify_on_start / notify_on_updates are RETAINED, not replaced: the Phase 7
-- follow endpoint and its callers still write them, and dropping them would
-- silently change existing rows' meaning.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "hearing_follow"
  ADD COLUMN IF NOT EXISTS "client_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD COLUMN IF NOT EXISTS "notify_on_schedule_change" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_on_hearing_starting" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_on_transcript_ready" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_on_high_priority_match" BOOLEAN NOT NULL DEFAULT true;

-- Fan-out reads the follows for one hearing and needs the client list with
-- them; GIN over client_ids answers "does any follow name this client?".
CREATE INDEX IF NOT EXISTS "hearing_follow_client_ids_idx"
  ON "hearing_follow" USING GIN ("client_ids");

-- ─────────────────────────────────────────────────────────────────────────
-- W1-2 — configurable attendance / capture request.
--
-- Attendance mode records WHICH mechanism the tenant asked for. It is a
-- request attribute of the tenant's demand row, never a property of the one
-- global capture: two tenants may ask for the same hearing by different
-- mechanisms and still share one canonical capture.
--
-- consent_acknowledged_at is the durable consent record for the modes that
-- require one. It is NOT a capture gate on its own — the server-side
-- eligibility assessment (assessSchedulePolicy) remains authoritative.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "hearing_subscription"
  ADD COLUMN IF NOT EXISTS "attendance_mode" TEXT NOT NULL DEFAULT 'automatic',
  ADD COLUMN IF NOT EXISTS "consent_acknowledged_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "notify_on_transcript_ready" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_on_intelligence_ready" BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hearing_subscription_attendance_mode_check'
  ) THEN
    ALTER TABLE "hearing_subscription"
      ADD CONSTRAINT "hearing_subscription_attendance_mode_check"
      CHECK ("attendance_mode" IN ('automatic', 'browser'));
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- W1-4 — committee following.
--
-- A committee follow is TENANT/USER state pointing at a canonical
-- congress_committee.system_code. Committee facts are never duplicated here:
-- this table stores interest and notification preference only.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "legiwatch_committee_follow" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  -- soft ref -> congress_committee.system_code (GLOBAL public record)
  "committee_system_code" TEXT NOT NULL,
  "client_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "notify_on_new_hearing" BOOLEAN NOT NULL DEFAULT true,
  "notify_on_schedule_change" BOOLEAN NOT NULL DEFAULT true,
  "notify_on_transcript_ready" BOOLEAN NOT NULL DEFAULT false,
  "notify_on_high_priority_match" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_committee_follow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_committee_follow_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "legiwatch_committee_follow_tenant_user_code_key"
  ON "legiwatch_committee_follow" ("tenant_id", "user_id", "committee_system_code");
CREATE INDEX IF NOT EXISTS "legiwatch_committee_follow_tenant_user_idx"
  ON "legiwatch_committee_follow" ("tenant_id", "user_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "legiwatch_committee_follow_code_idx"
  ON "legiwatch_committee_follow" ("committee_system_code");

-- ─────────────────────────────────────────────────────────────────────────
-- W1-7 — saved hearing references.
--
-- Stores CANONICAL REFERENCES ONLY (hearing / transcript segment /
-- intelligence finding / client), never a copy of the public transcript or
-- insight text. The optional note is the user's own tenant-private annotation.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "legiwatch_saved_item" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  -- 'moment'   = a transcript segment worth returning to
  -- 'finding'  = a public intelligence finding
  -- 'hearing'  = the proceeding itself, saved to a client
  "kind" TEXT NOT NULL,
  -- soft ref -> committee_hearing.id (GLOBAL)
  "hearing_id" TEXT NOT NULL,
  -- soft refs -> public_hearing_transcript_segment.id / public_hearing_insight.id
  "segment_id" TEXT,
  "insight_id" TEXT,
  "client_id" UUID,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_saved_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_saved_item_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_saved_item_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_saved_item_kind_check"
    CHECK ("kind" IN ('moment', 'finding', 'hearing')),
  -- A 'moment' is meaningless without the segment it points at, and a
  -- 'finding' without its insight. Enforced here so a malformed row can never
  -- render as a saved item that resolves to nothing.
  CONSTRAINT "legiwatch_saved_item_ref_check"
    CHECK (
      ("kind" = 'moment' AND "segment_id" IS NOT NULL)
      OR ("kind" = 'finding' AND "insight_id" IS NOT NULL)
      OR "kind" = 'hearing'
    )
);

-- Re-saving the same reference for the same client is idempotent rather than a
-- duplicate row. COALESCE keeps the uniqueness total: NULLs in a plain unique
-- index would let unlimited duplicates through.
CREATE UNIQUE INDEX IF NOT EXISTS "legiwatch_saved_item_dedup_key"
  ON "legiwatch_saved_item" (
    "tenant_id", "user_id", "kind", "hearing_id",
    COALESCE("segment_id", ''), COALESCE("insight_id", ''),
    COALESCE("client_id", '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX IF NOT EXISTS "legiwatch_saved_item_tenant_user_idx"
  ON "legiwatch_saved_item" ("tenant_id", "user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "legiwatch_saved_item_hearing_idx"
  ON "legiwatch_saved_item" ("tenant_id", "hearing_id");
CREATE INDEX IF NOT EXISTS "legiwatch_saved_item_client_idx"
  ON "legiwatch_saved_item" ("tenant_id", "client_id");

-- ─────────────────────────────────────────────────────────────────────────
-- W1-5 — lifecycle notification events.
--
-- This is NOT a parallel notification system. Channel delivery and its
-- idempotency continue to run through notification_log (unique on
-- alert_id+user_id+channel) exactly as tracker alerts do. This table is the
-- LegiWatch in-app inbox row plus the durable record of which lifecycle
-- transition produced it, which notification_log cannot express:
--
--   - notification_log.client_id is NOT NULL, so it cannot represent a
--     hearing-level event that belongs to no single client;
--   - notification_log has no deep-link target and no read state.
--
-- dedup_key is the idempotency key. It encodes the STATE TRANSITION, not the
-- observation, so repeatedly observing the same schedule cannot produce a
-- second notification.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "legiwatch_notification_event" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  -- 'schedule_changed' | 'location_changed' | 'witnesses_changed'
  -- | 'hearing_starting' | 'capture_started' | 'capture_failed'
  -- | 'transcript_ready' | 'intelligence_ready' | 'high_priority_match'
  "event_type" TEXT NOT NULL,
  -- soft ref -> committee_hearing.id (GLOBAL)
  "hearing_id" TEXT NOT NULL,
  -- soft ref -> congress_committee.system_code, set for committee-follow events
  "committee_system_code" TEXT,
  "client_id" UUID,
  "title" TEXT NOT NULL,
  "body" TEXT,
  -- canonical Hearing Detail route; never an external or per-client URL
  "deep_link" TEXT NOT NULL,
  -- the transition identity: same transition observed twice = same key
  "dedup_key" TEXT NOT NULL,
  "read_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_notification_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_notification_event_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_notification_event_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_notification_event_type_check"
    CHECK ("event_type" IN (
      'schedule_changed', 'location_changed', 'witnesses_changed',
      'hearing_starting', 'capture_started', 'capture_failed',
      'transcript_ready', 'intelligence_ready', 'high_priority_match'
    ))
);

-- The idempotency guarantee. A duplicate lifecycle observation collides here
-- and is dropped by the writer's ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS "legiwatch_notification_event_dedup_key"
  ON "legiwatch_notification_event" ("tenant_id", "user_id", "dedup_key");
CREATE INDEX IF NOT EXISTS "legiwatch_notification_event_inbox_idx"
  ON "legiwatch_notification_event" ("tenant_id", "user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "legiwatch_notification_event_hearing_idx"
  ON "legiwatch_notification_event" ("tenant_id", "hearing_id");

-- ─────────────────────────────────────────────────────────────────────────
-- RLS — every table above is tenant-owned and FORCE-isolated, matching the
-- posture of hearing_follow / hearing_subscription / tenant_hearing_relevance.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "legiwatch_committee_follow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_committee_follow" FORCE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_saved_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_saved_item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_notification_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_notification_event" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  p TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'legiwatch_committee_follow',
    'legiwatch_saved_item',
    'legiwatch_notification_event'
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_committee_follow" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_saved_item" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_notification_event" TO capiro_app;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- W1-3 — archive / global hearing research indexes.
--
-- Archive search runs SERVER-SIDE across the durable historical corpus. These
-- indexes back that query; without them a transcript-text search degrades to a
-- sequential scan of every captured segment.
--
-- 'english' is pinned as a literal so the index expression stays IMMUTABLE
-- (default_text_search_config is a session GUC and would make it not).
-- ─────────────────────────────────────────────────────────────────────────

-- Flatten a witness name array into one searchable string.
--
-- The obvious `array_to_string(witnesses, ' ')` CANNOT be used in an index
-- expression: array_to_string is STABLE (provolatile='s'), because in general
-- it calls the element type's output function. For a text[] the operation is
-- pure text concatenation with a constant separator, so this wrapper is
-- genuinely immutable and may be declared as such.
--
-- array_to_tsvector() is immutable but is NOT a substitute: it makes each whole
-- array element one lexeme, so a full name becomes 'Jane Doe' and a search for
-- "Doe" would not match it. Flattening first lets the english config tokenize
-- the names properly.
CREATE OR REPLACE FUNCTION legiwatch_witness_text("names" TEXT[])
  RETURNS TEXT
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  RETURNS NULL ON NULL INPUT
AS $$
  SELECT coalesce(string_agg("w", ' '), '') FROM unnest("names") AS "w"
$$;

-- Hearing identity: title + committee + location + witnesses as one document.
CREATE INDEX IF NOT EXISTS "committee_hearing_search_fts_idx"
  ON "committee_hearing"
  USING GIN (
    to_tsvector(
      'english',
      coalesce("title", '') || ' ' ||
      coalesce("committee_name", '') || ' ' ||
      coalesce("location", '') || ' ' ||
      legiwatch_witness_text("witnesses")
    )
  );

-- Machine transcript segment text (canonical capture transcript).
CREATE INDEX IF NOT EXISTS "public_hearing_transcript_segment_fts_idx"
  ON "public_hearing_transcript_segment"
  USING GIN (to_tsvector('english', "text"));

-- Official published transcript text (GovInfo CHRG).
CREATE INDEX IF NOT EXISTS "official_hearing_transcript_fts_idx"
  ON "official_hearing_transcript"
  USING GIN (to_tsvector('english', "text"));

-- Public intelligence findings (title + summary + evidence quote).
CREATE INDEX IF NOT EXISTS "public_hearing_insight_fts_idx"
  ON "public_hearing_insight"
  USING GIN (
    to_tsvector(
      'english',
      coalesce("title", '') || ' ' ||
      coalesce("summary", '') || ' ' ||
      coalesce("evidence_text", '')
    )
  );

-- Archive orders by "most recent proceeding first" over the whole corpus. The
-- ordering expression itself (COALESCE over actual_end/starts_at/date) cannot
-- be indexed: date -> timestamp casting is STABLE, not IMMUTABLE, because it
-- depends on the session TimeZone. These two cover the same ordering for the
-- rows that actually have each field, which is what the planner needs.
CREATE INDEX IF NOT EXISTS "committee_hearing_archive_starts_at_idx"
  ON "committee_hearing" ("starts_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "committee_hearing_archive_date_idx"
  ON "committee_hearing" ("date" DESC, "id" DESC);
