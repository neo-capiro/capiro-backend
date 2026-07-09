-- LegiWatch outcome truth layer (Workstream A): roll-call votes, per-member
-- positions, rule->bill linkage, and canonical bill status/text-freshness
-- columns. All GLOBAL public-record (congress_bill class). Additive only.

-- 1. congress_bill: text-freshness (A3) + canonical status (A4)
ALTER TABLE "congress_bill" ADD COLUMN "update_date_including_text" TIMESTAMPTZ(6);
ALTER TABLE "congress_bill" ADD COLUMN "status" TEXT;
ALTER TABLE "congress_bill" ADD COLUMN "status_at" TIMESTAMPTZ(6);
CREATE INDEX "congress_bill_status_idx" ON "congress_bill"("status");

-- 2. Roll-call votes
CREATE TABLE "roll_call_vote" (
  "id"             TEXT NOT NULL,
  "chamber"        TEXT NOT NULL,
  "congress"       INTEGER NOT NULL,
  "session"        INTEGER NOT NULL,
  "roll_number"    INTEGER NOT NULL,
  "bill_id"        TEXT,
  "question"       TEXT,
  "result"         TEXT,
  "vote_type"      TEXT,
  "vote_date"      TIMESTAMPTZ(6) NOT NULL,
  "yeas"           INTEGER NOT NULL DEFAULT 0,
  "nays"           INTEGER NOT NULL DEFAULT 0,
  "present"        INTEGER NOT NULL DEFAULT 0,
  "not_voting"     INTEGER NOT NULL DEFAULT 0,
  "party_totals"   JSONB NOT NULL DEFAULT '{}',
  "title"          TEXT,
  "source_url"     TEXT,
  "source"         TEXT NOT NULL,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "roll_call_vote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "roll_call_vote_bill_id_idx" ON "roll_call_vote"("bill_id");
CREATE INDEX "roll_call_vote_chamber_congress_session_idx"
  ON "roll_call_vote"("chamber", "congress", "session");
CREATE INDEX "roll_call_vote_vote_date_idx" ON "roll_call_vote"("vote_date" DESC);

-- 3. Per-member positions
CREATE TABLE "member_vote" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "vote_id"     TEXT NOT NULL,
  "member_key"  TEXT NOT NULL,
  "bioguide_id" TEXT,
  "lis_id"      TEXT,
  "vote_cast"   TEXT NOT NULL,
  "party"       TEXT,
  "state"       TEXT,
  CONSTRAINT "member_vote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_vote_vote_id_fkey" FOREIGN KEY ("vote_id")
    REFERENCES "roll_call_vote"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "member_vote_vote_id_member_key_key"
  ON "member_vote"("vote_id", "member_key");
CREATE INDEX "member_vote_bioguide_id_idx" ON "member_vote"("bioguide_id");

-- 4. Rule -> target bill linkage
CREATE TABLE "bill_rule_link" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "rule_bill_id"   TEXT NOT NULL,
  "target_bill_id" TEXT NOT NULL,
  "source"         TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bill_rule_link_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bill_rule_link_rule_bill_id_target_bill_id_key"
  ON "bill_rule_link"("rule_bill_id", "target_bill_id");
CREATE INDEX "bill_rule_link_target_bill_id_idx" ON "bill_rule_link"("target_bill_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "roll_call_vote" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "member_vote" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "bill_rule_link" TO capiro_app;
  END IF;
END
$$;
