-- Engagement priority tier for client targets (1 = highest .. 3), null = untiered.
-- Additive, nullable — existing targets default to untiered.
ALTER TABLE "client_targets" ADD COLUMN IF NOT EXISTS "tier" SMALLINT;
