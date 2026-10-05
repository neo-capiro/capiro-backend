-- Meri Stage 2 Release A (program plan §5.1): research sessions become jobs.
-- Additive only. Existing rows read as research jobs at goal revision 0 with no
-- deliverables; every existing reader and writer keeps working unchanged.
ALTER TABLE "clio_research_sessions"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'research',
  ADD COLUMN IF NOT EXISTS "goal_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deliverables_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  ALTER TABLE "clio_research_sessions"
    ADD CONSTRAINT "clio_research_sessions_kind_check"
    CHECK ("kind" IN ('research', 'deliverable', 'audit', 'scheduled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "clio_research_sessions"
    ADD CONSTRAINT "clio_research_sessions_goal_revision_check"
    CHECK ("goal_revision" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "clio_research_sessions"
    ADD CONSTRAINT "clio_research_sessions_deliverables_array_check"
    CHECK (jsonb_typeof("deliverables_jsonb") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Jobs rail: one user's jobs of a kind, newest first.
CREATE INDEX IF NOT EXISTS "clio_research_sessions_tenant_user_kind_updated_idx"
  ON "clio_research_sessions" ("tenant_id", "user_id", "kind", "updated_at" DESC);

-- Lease sweeper: only runs that still claim to be live are scanned.
CREATE INDEX IF NOT EXISTS "clio_research_sessions_live_run_heartbeat_idx"
  ON "clio_research_sessions" (("metadata_jsonb" #>> '{run,heartbeatAt}'))
  WHERE ("metadata_jsonb" #>> '{run,status}') IN ('running', 'cancel_requested');
