-- Funding Opportunities — independent §6.2 review remediation.
--
-- Closes finding F-1 (band-a-p07-p08.md §3; master queue P1-3, High): P08's
-- "atomic review/pursuit task action" can create duplicate engagement_tasks
-- rows under concurrency, because the find-then-create check in
-- FundingOpportunityActionsService.act() has no unique constraint backing
-- it. Reproduced against a real 263-migration replay of
-- pgvector/pgvector:pg16 with real @prisma/client 5.22.0 interactive
-- transactions: 2 rows from 2 concurrent identical calls, and 2 rows from 8
-- parallel calls with NO injected delay.
--
-- THE FIX IS THE SAME SHAPE THIS PROGRAM ALREADY USES
-- -------------------------------------------------------------------------
-- client_funding_opportunity solved this identical problem for its own
-- find-then-create paths (setWorkflowStatus, decide, patchWorkflow) with a
-- PARTIAL unique index plus a service-layer catch of Prisma P2002 — see
-- 20260810010000_funding_opportunities and
-- 20260820010000_funding_opportunity_generic_source. This migration is the
-- database half of the identical remedy for engagement_tasks; the code half
-- (catching P2002 in act() and returning the winning row) is tracked in
-- docs/plans/funding-opportunities-makegov-v1/independent-review/FIX-PLAN-p08-idempotency.md
-- and must ship in the SAME deploy as this migration — see that document's
-- section 10.1 for why the migration alone is unsafe to ship first.
--
-- WHY PARTIAL
-- -----------
-- source_type/source_id are NULL for every task created through the
-- generic path (EngagementService.createTask,
-- apps/api/src/engagement/engagement.service.ts, never sets either column)
-- — the overwhelming majority of rows in this table. This repository's
-- convention (see the comment on client_funding_opportunity_grant_uniq) is
-- to say so explicitly with a WHERE clause, and a partial index is also
-- smaller, since it excludes those rows entirely.
--
-- WHY (tenant_id, source_type, source_id) AND NOT ALSO client_id
-- -------------------------------------------------------------------------
-- Matches the `findFirst` in act() exactly:
--   where: { tenantId, sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE, sourceId }
-- which does not filter on client_id either. Widening the key would change
-- existing behaviour (whether two different clients in the same tenant
-- pursuing the same source opportunity share one task) — a separate,
-- pre-existing question this migration deliberately does not decide. See
-- FIX-PLAN-p08-idempotency.md section 11.
--
-- PRE-FLIGHT DUPLICATE CHECK
-- -------------------------------------------------------------------------
-- CREATE UNIQUE INDEX fails outright over existing duplicates — exactly
-- what the review's own probe hit (Postgres error 23505) applying this same
-- index shape to rows its own concurrency test had just duplicated. Guarded
-- here with the same check-then-RAISE pattern as
-- 20260728230000_add_tenant_scoped_pe_watch_key, so a real duplicate
-- already sitting in a target database blocks this migration with a clear
-- message instead of dying with a bare constraint-violation stack trace.
-- See FIX-PLAN-p08-idempotency.md section 10 for the read-only query to run
-- against capiro-dev before this migration is deployed there, and for what
-- to do if it finds one.
--
-- RLS: untouched, deliberately — the same call
-- 20260819010000_funding_opportunity_decisions made for
-- client_funding_opportunity. engagement_tasks already has RLS ENABLED +
-- FORCED with its one combined engagement_tasks_isolation policy
-- (USING/WITH CHECK tenant_id = current_tenant_id()), from
-- 20260503020000_engagement_manager_core. An index changes nothing about
-- access control, and re-issuing the policy would risk replacing it with a
-- subtly different predicate for no reason.
--
-- Additive only: no column added, no type changed, no existing index,
-- constraint or policy touched. Every statement is retry-safe.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "engagement_tasks"
    WHERE "source_type" IS NOT NULL AND "source_id" IS NOT NULL
    GROUP BY "tenant_id", "source_type", "source_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'engagement_tasks has duplicate (tenant_id, source_type, source_id) rows; resolve them before this unique index can apply — see FIX-PLAN-p08-idempotency.md section 10';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_tasks_tenant_source_uniq"
    ON "engagement_tasks" ("tenant_id", "source_type", "source_id")
    WHERE "source_type" IS NOT NULL AND "source_id" IS NOT NULL;
