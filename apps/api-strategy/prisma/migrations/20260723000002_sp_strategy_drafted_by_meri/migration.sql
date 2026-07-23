-- G5 (SHL-5): immutable provenance flag — true only for a plan Meri drafted
-- from a goal. Keeps the "Meri drafted this plan" banner from firing on manual
-- plans that later gain a meriSummary via a rail assist. Additive, defaulted.
ALTER TABLE "sp_strategy" ADD COLUMN "drafted_by_meri" BOOLEAN NOT NULL DEFAULT false;
