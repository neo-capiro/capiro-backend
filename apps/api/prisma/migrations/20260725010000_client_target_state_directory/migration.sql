-- Client targets can now come from two directories: congressional (LegiStorm
-- snapshot) or state legislators (OpenStates state_legislator table). Add a
-- source_directory discriminator (existing rows are all congressional) and widen
-- party/state/chamber because state values are full words ("Democrat", "upper")
-- and district-qualified states ("CA-upper-12") exceed the old congressional
-- widths. All changes are additive / widening — no data loss.
ALTER TABLE "client_targets"
  ADD COLUMN IF NOT EXISTS "source_directory" VARCHAR(16) NOT NULL DEFAULT 'congress';

ALTER TABLE "client_targets" ALTER COLUMN "party" TYPE VARCHAR(32);
-- TEXT, not VARCHAR: some state legislators have NAMED districts (e.g. Massachusetts
-- "Norfolk, Bristol and Plymouth"), so the district-qualified state value is unbounded.
ALTER TABLE "client_targets" ALTER COLUMN "state" TYPE TEXT;
ALTER TABLE "client_targets" ALTER COLUMN "chamber" TYPE VARCHAR(24);
