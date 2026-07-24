-- Committee membership watch ledger (WS-G, LegiStorm gaps/enrichment plan —
-- optional temporal enrichment). New, standalone table — no FK to any
-- tenant-scoped table (it's our own bookkeeping ledger, not vendor data).
-- Safe on a live database: CREATEs a brand-new table, touches nothing
-- existing, requires no backfill (the first emit-committee-changes.ts run
-- treats every current membership as newly "gained" and populates this
-- table from scratch — see the script's own header for that first-run note).
CREATE TABLE "committee_membership_watch" (
  "committee_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "person_name" TEXT,
  "role" TEXT,
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "committee_membership_watch_pkey" PRIMARY KEY ("committee_id", "person_id")
);
