-- Meetings & Meri Phase 2 groundwork (docs/plans/2026-07-11-meetings-meri-phase2-plan.md §4).
-- Capture Microsoft Graph's cross-mailbox-stable iCalUId on meetings so a future
-- (flag-gated) cross-user collision model can group/dedupe the per-mailbox rows
-- two attendees' syncs produce. Additive + DORMANT — nothing reads it yet.
-- Column on the already-RLS-protected meetings table (no new policy needed).

ALTER TABLE "meetings" ADD COLUMN "ical_uid" TEXT;

CREATE INDEX "meetings_tenant_ical_idx" ON "meetings" ("tenant_id", "ical_uid");
