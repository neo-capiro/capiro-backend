-- State Legislation Platform Phase 0 (S2): the state truth layer. LegiScan
-- becomes the bill spine; OpenStates stays for people/committees. state_bill
-- is re-keyed to the canonical natural id "<state>-<sessionKey>-<billnumber>"
-- (DD1, parent plan D3) — a wipe-and-resync is safe because nothing has an
-- inbound FK to state_bill.id today (verified: intel_tracked_bill only
-- accepts congress ids; search_state_bills / Data Explorer reads are
-- pass-through). All tables GLOBAL — no tenant_id, no RLS (congress_bill
-- posture). Runbook: apply this migration, then run
-- `backfill-legiscan-datasets LEGISCAN_STATES=all` same-day so Explorer
-- repopulates in one pass
-- (docs/plans/2026-07-09-state-phase0-implementation-plan.md §10 step 3).

-- 1. Wipe state_bill BEFORE adding NOT NULL columns (empty table => no
--    default needed) and before any FK children reference it below.
TRUNCATE TABLE "state_bill";

-- 2. state_bill: re-key columns + canonical status + LegiScan/OpenStates ids
ALTER TABLE "state_bill" ADD COLUMN "session_key" TEXT NOT NULL;
ALTER TABLE "state_bill" ADD COLUMN "bill_number" TEXT NOT NULL;
ALTER TABLE "state_bill" ADD COLUMN "description" TEXT;
ALTER TABLE "state_bill" ADD COLUMN "sponsor_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "state_bill" ADD COLUMN "status" TEXT;
ALTER TABLE "state_bill" ADD COLUMN "status_at" TIMESTAMPTZ(6);
ALTER TABLE "state_bill" ADD COLUMN "status_source" TEXT;
ALTER TABLE "state_bill" ADD COLUMN "legiscan_status" INTEGER;
ALTER TABLE "state_bill" ADD COLUMN "legiscan_progress" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "state_bill" ADD COLUMN "text_date" TIMESTAMPTZ(6);
ALTER TABLE "state_bill" ADD COLUMN "state_url" TEXT;
ALTER TABLE "state_bill" ADD COLUMN "legiscan_bill_id" INTEGER;
ALTER TABLE "state_bill" ADD COLUMN "legiscan_change_hash" TEXT;
ALTER TABLE "state_bill" ADD COLUMN "openstates_id" TEXT;
CREATE UNIQUE INDEX "state_bill_legiscan_bill_id_key" ON "state_bill"("legiscan_bill_id");
CREATE INDEX "state_bill_state_status_idx" ON "state_bill"("state", "status");

-- 3. state_legislator: LegiScan people crosswalk column (no re-key needed —
--    openstates id stays PK)
ALTER TABLE "state_legislator" ADD COLUMN "legiscan_people_id" INTEGER;
CREATE UNIQUE INDEX "state_legislator_legiscan_people_id_key" ON "state_legislator"("legiscan_people_id");

-- 4. State bill action history (mirrors congress_bill_action). Append-only;
--    first_seen_at is the SLA telemetry anchor (S1.6) and must never be
--    touched by re-drains.
CREATE TABLE "state_bill_action" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "bill_key"      TEXT NOT NULL,
  "date"          DATE NOT NULL,
  "text"          TEXT NOT NULL,
  "chamber"       TEXT,
  "importance"    INTEGER,
  "order_key"     INTEGER NOT NULL,
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_bill_action_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "state_bill_action_bill_key_fkey" FOREIGN KEY ("bill_key")
    REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "state_bill_action_bill_key_date_order_key_key"
  ON "state_bill_action"("bill_key", "date", "order_key");
CREATE INDEX "state_bill_action_bill_key_date_idx" ON "state_bill_action"("bill_key", "date");
CREATE INDEX "state_bill_action_first_seen_at_idx" ON "state_bill_action"("first_seen_at");

-- 5. State bill sponsors (mirrors congress_bill_cosponsor). Diff-synced — new
--    rows inserted via anti-join (stamping first_seen_at), withdrawals
--    removed, existing rows never blanket-recreated.
CREATE TABLE "state_bill_sponsor" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "bill_key"           TEXT NOT NULL,
  "legiscan_people_id" INTEGER,
  "legislator_id"      TEXT,
  "name"               TEXT NOT NULL,
  "party"              TEXT,
  "sponsor_type"       TEXT NOT NULL,
  "sponsor_order"      INTEGER NOT NULL,
  "first_seen_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_synced_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_bill_sponsor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "state_bill_sponsor_bill_key_fkey" FOREIGN KEY ("bill_key")
    REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "state_bill_sponsor_bill_key_legiscan_people_id_key"
  ON "state_bill_sponsor"("bill_key", "legiscan_people_id");
CREATE INDEX "state_bill_sponsor_legislator_id_idx" ON "state_bill_sponsor"("legislator_id");

-- 6. State roll-call votes + per-member positions (mirrors roll_call_vote /
--    member_vote). bill_key is a SOFT ref (no FK) — a vote may reference a
--    bill not yet drained; votes are immutable once recorded, never deleted.
CREATE TABLE "state_roll_call_vote" (
  "id"                    TEXT NOT NULL,
  "bill_key"              TEXT,
  "legiscan_roll_call_id" INTEGER NOT NULL,
  "chamber"               TEXT,
  "date"                  DATE NOT NULL,
  "motion"                TEXT,
  "yeas"                  INTEGER NOT NULL DEFAULT 0,
  "nays"                  INTEGER NOT NULL DEFAULT 0,
  "nv"                    INTEGER NOT NULL DEFAULT 0,
  "absent"                INTEGER NOT NULL DEFAULT 0,
  "passed"                BOOLEAN,
  "source_url"            TEXT,
  "last_synced_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_roll_call_vote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "state_roll_call_vote_legiscan_roll_call_id_key"
  ON "state_roll_call_vote"("legiscan_roll_call_id");
CREATE INDEX "state_roll_call_vote_bill_key_idx" ON "state_roll_call_vote"("bill_key");
CREATE INDEX "state_roll_call_vote_date_idx" ON "state_roll_call_vote"("date" DESC);

CREATE TABLE "state_member_vote" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "vote_id"            TEXT NOT NULL,
  "legiscan_people_id" INTEGER NOT NULL,
  "legislator_id"      TEXT,
  "vote_cast"          TEXT NOT NULL,
  CONSTRAINT "state_member_vote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "state_member_vote_vote_id_fkey" FOREIGN KEY ("vote_id")
    REFERENCES "state_roll_call_vote"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "state_member_vote_vote_id_legiscan_people_id_key"
  ON "state_member_vote"("vote_id", "legiscan_people_id");
CREATE INDEX "state_member_vote_legislator_id_idx" ON "state_member_vote"("legislator_id");

-- 7. State bill version metadata ONLY (DD7 — no text blobs in Phase 0; the
--    text-changed emitter anchors on state_bill.text_date, not content).
CREATE TABLE "state_bill_version" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "bill_key"        TEXT NOT NULL,
  "legiscan_doc_id" INTEGER NOT NULL,
  "version_type"    TEXT NOT NULL,
  "date"            DATE NOT NULL,
  "state_url"       TEXT,
  "mime"            TEXT,
  "last_synced_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_bill_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "state_bill_version_bill_key_fkey" FOREIGN KEY ("bill_key")
    REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "state_bill_version_legiscan_doc_id_key" ON "state_bill_version"("legiscan_doc_id");
CREATE INDEX "state_bill_version_bill_key_date_idx" ON "state_bill_version"("bill_key", "date");

-- 8. Bill<->bill links from LegiScan `sasts` (mirrors bill_rule_link,
--    generalized to same_as/companion/similar/replaces/replaced_by).
CREATE TABLE "state_bill_link" (
  "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
  "bill_key"                 TEXT NOT NULL,
  "related_bill_key"         TEXT,
  "legiscan_related_bill_id" INTEGER NOT NULL,
  "link_type"                TEXT NOT NULL,
  "last_synced_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_bill_link_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "state_bill_link_bill_key_fkey" FOREIGN KEY ("bill_key")
    REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "state_bill_link_bill_key_legiscan_related_bill_id_key"
  ON "state_bill_link"("bill_key", "legiscan_related_bill_id");
CREATE INDEX "state_bill_link_related_bill_key_idx" ON "state_bill_link"("related_bill_key");

-- 9. State bill calendar events (hearing/exec session/floor). Flattened —
--    LegiScan calendar[] arrives per-bill; delete-and-recreate per drain.
CREATE TABLE "state_bill_calendar_event" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "bill_key"       TEXT NOT NULL,
  "event_type"     TEXT NOT NULL,
  "date"           DATE NOT NULL,
  "time"           TEXT,
  "location"       TEXT,
  "event_key"      TEXT NOT NULL,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_bill_calendar_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "state_bill_calendar_event_bill_key_fkey" FOREIGN KEY ("bill_key")
    REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "state_bill_calendar_event_bill_key_event_key_key"
  ON "state_bill_calendar_event"("bill_key", "event_key");
CREATE INDEX "state_bill_calendar_event_date_idx" ON "state_bill_calendar_event"("date");

-- 10. LegiScan session registry (sine_die backs dead_by_deadline status, S3).
CREATE TABLE "state_session" (
  "id"                  TEXT NOT NULL,
  "state"               TEXT NOT NULL,
  "legiscan_session_id" INTEGER NOT NULL,
  "session_key"         TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "year_start"          INTEGER NOT NULL,
  "year_end"            INTEGER NOT NULL,
  "special"             BOOLEAN NOT NULL DEFAULT false,
  "sine_die"            DATE,
  "prior"               BOOLEAN NOT NULL DEFAULT false,
  "last_synced_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "state_session_legiscan_session_id_key" ON "state_session"("legiscan_session_id");
CREATE INDEX "state_session_state_idx" ON "state_session"("state");

-- 11. Committee registry (roster normalization stays Phase 1).
CREATE TABLE "state_committee" (
  "id"                    TEXT NOT NULL,
  "state"                 TEXT NOT NULL,
  "chamber"               TEXT,
  "name"                  TEXT NOT NULL,
  "legiscan_committee_id" INTEGER,
  "last_synced_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "state_committee_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "state_committee_legiscan_committee_id_key" ON "state_committee"("legiscan_committee_id");

-- 12. Per-(state,session) LegiScan cursor: change_hash cache for the
--     masterlist diff, the bill-drain queue, and quota self-accounting
--     (LegiScan sends no quota headers).
CREATE TABLE "state_sync_cursor" (
  "id"            TEXT NOT NULL,
  "state"         TEXT NOT NULL,
  "session_id"    INTEGER NOT NULL,
  "session_key"   TEXT NOT NULL,
  "bill_hashes"   JSONB NOT NULL DEFAULT '{}',
  "pending_bills" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "queries_used"  INTEGER NOT NULL DEFAULT 0,
  "quota_month"   TEXT,
  "last_list_at"  TIMESTAMPTZ(6),
  "last_drain_at" TIMESTAMPTZ(6),
  CONSTRAINT "state_sync_cursor_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "state_sync_cursor_state_idx" ON "state_sync_cursor"("state");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_bill_action" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_bill_sponsor" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_roll_call_vote" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_member_vote" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_bill_version" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_bill_link" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_bill_calendar_event" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_session" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_committee" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "state_sync_cursor" TO capiro_app;
  END IF;
END
$$;
