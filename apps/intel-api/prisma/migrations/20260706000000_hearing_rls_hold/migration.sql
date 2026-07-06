-- HOLD MIGRATION — DO NOT MERGE without a clone-tested cutover window
-- (same discipline as clio_memory's RLS rollout, PR #246).
--
-- Row-Level Security for the 6 Live Hearing tables ONLY (G3, partial). intel-api
-- shares apps/api's Aurora `capiro` DB and its current_tenant_id()/rls_bypass()
-- GUC functions (defined in apps/api migration 20260501000000) already exist —
-- nothing to port. The blocker was that NO intel_* CRUD caller set the
-- app.current_tenant GUC, so applying RLS would have silently blanked every
-- tenant's data (0 rows, not an error) for every intel_* table.
--
-- SCOPE: this migration covers ONLY the 6 tables whose callers have been
-- verified to route through PrismaService.withTenant (the hearing module:
-- hearing-session.service.ts, segment-commit.service.ts, hearing-brief.service.ts,
-- post-hearing.service.ts — see hearing-tenant-scoping.spec.ts). Every OTHER
-- intel_* table (feed / action items, tracker, watchlist, linking, sourcedata,
-- feature flags — ~85 additional call sites across ~17 files, audited but NOT
-- converted) is DELIBERATELY EXCLUDED. Enabling RLS on those tables before
-- converting their callers would blank Radar/LegiWatch for all 4 tenants.
--
-- LANDMINE (PG 42883, "operator does not exist: text = uuid"): unlike
-- clio_memory (tenantId has an explicit @db.Uuid), these tables' tenant_id
-- columns are plain TEXT (Prisma `String` with no @db.Uuid override, per
-- schema.prisma) while current_tenant_id() returns UUID — every predicate below
-- casts current_tenant_id()::text. Do NOT drop the cast when copying this
-- pattern to another intel_* table without checking its column type first.
--
-- Policy functions current_tenant_id() (reads app.current_tenant) and
-- rls_bypass() (reads app.bypass_rls) are defined in apps/api migration
-- 20260501000000_init_identity_tenancy — this migration only adds policies.

ALTER TABLE "intel_live_hearing_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_live_hearing_session" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intel_live_hearing_session_isolation" ON "intel_live_hearing_session"
  USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);

ALTER TABLE "intel_transcript_segment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_transcript_segment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intel_transcript_segment_isolation" ON "intel_transcript_segment"
  USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);

ALTER TABLE "intel_key_quote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_key_quote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intel_key_quote_isolation" ON "intel_key_quote"
  USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);

ALTER TABLE "intel_live_action_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_live_action_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intel_live_action_item_isolation" ON "intel_live_action_item"
  USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);

ALTER TABLE "intel_entity_mention" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_entity_mention" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intel_entity_mention_isolation" ON "intel_entity_mention"
  USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);

ALTER TABLE "intel_live_summary_card" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_live_summary_card" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intel_live_summary_card_isolation" ON "intel_live_summary_card"
  USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_live_hearing_session" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_transcript_segment" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_key_quote" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_live_action_item" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_entity_mention" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_live_summary_card" TO capiro_app;
  END IF;
END
$$;
