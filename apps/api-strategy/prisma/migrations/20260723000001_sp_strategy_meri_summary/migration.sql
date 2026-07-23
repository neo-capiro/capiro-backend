-- G5: persist Meri's 1-2 sentence plan summary on the strategy (MRI-2), set on
-- draft-from-goal and refreshed after Meri edit-sets. Additive + nullable.
ALTER TABLE "sp_strategy" ADD COLUMN "meri_summary" TEXT;
