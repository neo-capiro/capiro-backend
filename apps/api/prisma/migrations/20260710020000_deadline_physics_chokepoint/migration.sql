-- Phase 1 M2.1 — state_session procedural calendar (crossover/committee cutoffs), NCSL-curated.
ALTER TABLE "state_session"
  ADD COLUMN "convene" DATE,
  ADD COLUMN "crossover_date" DATE,
  ADD COLUMN "committee_cutoff_date" DATE,
  ADD COLUMN "second_committee_cutoff_date" DATE,
  ADD COLUMN "calendar_source" TEXT,
  ADD COLUMN "calendar_confidence" TEXT;

-- Phase 1 M2.2 — state bill's current committee referral (soft ref to state_committee.id).
ALTER TABLE "state_bill"
  ADD COLUMN "current_committee_id" TEXT;
CREATE INDEX "state_bill_currentCommitteeId_idx" ON "state_bill" ("current_committee_id");

-- Phase 1 M2.2 — state committee roster (normalized from state_legislator.committees Json).
CREATE TABLE "state_committee_membership" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "committee_id"   TEXT NOT NULL,
  "legislator_id"  TEXT NOT NULL,
  "role"           TEXT,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "state_committee_membership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "state_committee_membership_committee_id_legislator_id_key" ON "state_committee_membership" ("committee_id", "legislator_id");
CREATE INDEX "state_committee_membership_legislator_id_idx" ON "state_committee_membership" ("legislator_id");

ALTER TABLE "state_committee_membership"
  ADD CONSTRAINT "state_committee_membership_committee_id_fkey" FOREIGN KEY ("committee_id") REFERENCES "state_committee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "state_committee_membership"
  ADD CONSTRAINT "state_committee_membership_legislator_id_fkey" FOREIGN KEY ("legislator_id") REFERENCES "state_legislator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
