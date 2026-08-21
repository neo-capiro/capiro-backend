-- Phase 8 Session 10 — schedule-tick audit.
--
-- Session 7 built `defense_budget_watcher_adapter.next_check_at`, indexed it,
-- and left it unread by anything: every entrypoint before this session was a
-- manual, single-adapter CLI invocation. This session adds the first caller
-- that ever queries `next_check_at` as a scheduling signal, and this table is
-- what makes ITS OWN decisions auditable — not a per-adapter run record
-- (`defense_budget_watcher_run` already is one), but a per-TICK summary: at
-- this instant, this worker considered N adapters, M were due, and of those,
-- how many succeeded, failed outright, or lost a lease race.
--
-- Without this table, "the scheduler has not run in three days" and "the
-- scheduler has been running and finding nothing due" are indistinguishable
-- from outside. `started_at`/`outcome` are exactly the two columns a
-- staleness check would read.
--
-- What it deliberately does NOT hold: no fiscal year, no authority track, no
-- adapter-level detail (that already lives in defense_budget_watcher_run, one
-- row per adapter run), no monetary column (provider/parser spend is not a
-- funding fact, Sessions 7-9 asserted no dollars and so does this one), and no
-- secret or credential (nothing on the path a scheduled tick touches — the
-- registry, the lease SQL, the domain classifier — ever holds one).
--
-- Upsertable by (worker_id, tick_key), like defense_budget_watcher_run: a
-- retried write for the same tick replaces its own row rather than
-- duplicating the trail. This is a run record, not a low-level immutable
-- observation, so it follows that precedent rather than the strict
-- INSERT-only shape of defense_provider_invocation or
-- defense_budget_discovery_crawl.

CREATE TABLE "defense_budget_schedule_tick" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "worker_id" TEXT NOT NULL,
  "tick_key" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "finished_at" TIMESTAMPTZ(6) NOT NULL,
  "outcome" TEXT NOT NULL,
  "horizon_bootstrapped" BOOLEAN NOT NULL,
  "adapters_considered" INTEGER NOT NULL,
  "adapters_due" INTEGER NOT NULL,
  "adapters_succeeded" INTEGER NOT NULL,
  "adapters_failed" INTEGER NOT NULL,
  "adapters_skipped_lease" INTEGER NOT NULL,
  "committed" BOOLEAN NOT NULL,
  "failure_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dbst_outcome_chk" CHECK ("outcome" IN ('completed', 'failed')),
  CONSTRAINT "dbst_outcome_failure_reason_chk" CHECK (
    ("outcome" = 'failed') = ("failure_reason" IS NOT NULL)
  ),
  CONSTRAINT "dbst_failure_reason_len_chk" CHECK (
    "failure_reason" IS NULL OR length("failure_reason") <= 500
  ),
  CONSTRAINT "dbst_window_chk" CHECK ("finished_at" >= "started_at"),
  CONSTRAINT "dbst_worker_id_chk" CHECK (length(btrim("worker_id")) > 0),
  CONSTRAINT "dbst_tick_key_chk" CHECK (length(btrim("tick_key")) > 0),
  CONSTRAINT "dbst_nonneg_chk" CHECK (
    "adapters_considered" >= 0
    AND "adapters_due" >= 0
    AND "adapters_succeeded" >= 0
    AND "adapters_failed" >= 0
    AND "adapters_skipped_lease" >= 0
  ),
  CONSTRAINT "dbst_due_bounds_chk" CHECK ("adapters_due" <= "adapters_considered"),
  CONSTRAINT "dbst_partition_chk" CHECK (
    "adapters_succeeded" + "adapters_failed" + "adapters_skipped_lease" = "adapters_due"
  )
);

CREATE UNIQUE INDEX "dbst_worker_tick_key_uidx"
  ON "defense_budget_schedule_tick" ("worker_id", "tick_key");
CREATE INDEX "dbst_started_idx" ON "defense_budget_schedule_tick" ("started_at" DESC);
CREATE INDEX "dbst_outcome_idx" ON "defense_budget_schedule_tick" ("outcome");

-- ───────────────────────────────────────────────────────────────────────────
-- Least-privilege grants, matching the defense_budget_watcher_run precedent
-- (a run record, not a low-level append-only observation): the job role gets
-- SELECT/INSERT/UPDATE and no DELETE, so a retried tick write can replace its
-- own row but the tick history is never erased. The serve role gets the same
-- blanket SELECT every Session 7 control-plane table already carries, in case
-- a future read surface needs it — Session 10 adds no route that uses it.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE "defense_budget_schedule_tick" FROM PUBLIC;

GRANT SELECT ON TABLE "defense_budget_schedule_tick" TO "capiro_defense_serve";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_schedule_tick" TO "capiro_defense_job";
