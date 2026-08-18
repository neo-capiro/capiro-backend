-- Teach outreach_records.type about the reserved Outreach V3 artifact root.
--
-- OutreachV3ArtifactRootService.ensureRoot() inserts a compatibility parent row
-- with type = 'outreach_v3' (OUTREACH_V3_INTERNAL_RECORD_TYPE) so the mature
-- immutable draft/send FK graph has a stable parent per V3 campaign. The type
-- CHECK constraint was created with ('campaign','follow_up','prep') and last
-- widened to add 'outbound_campaign' (20260507030000_outbound_campaign_templates);
-- it was never widened for the V3 root.
--
-- Live consequence (capiro-dev-engagement-api, observed 2026-08-18): every
-- POST /generation/samples failed with SQLSTATE 23514
--   new row for relation "outreach_records" violates check constraint
--   "outreach_records_type_check"
-- raised from ensureRoot before the first model call, so V3 sample generation,
-- full generation, drafts and send were all unreachable for every tenant.
--
-- outreach-v3-artifact-root.spec.ts pins this constraint against the TypeScript
-- constant so the two halves cannot drift apart again.

ALTER TABLE "outreach_records"
  DROP CONSTRAINT IF EXISTS "outreach_records_type_check";

ALTER TABLE "outreach_records"
  ADD CONSTRAINT "outreach_records_type_check"
  CHECK ("type" IN ('campaign', 'follow_up', 'prep', 'outbound_campaign', 'outreach_v3'));
