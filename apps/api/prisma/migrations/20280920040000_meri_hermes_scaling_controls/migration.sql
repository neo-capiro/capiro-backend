-- Phase 1 scaling obligations S-1..S-4: distributed budgets, fairness/queueing
-- and profile-write coordination for the Meri/Hermes runtime. Additive only
-- (four new tables; nothing existing is altered).
--
-- The numbers these tables enforce are NOT invented here. They are the pilot
-- envelope declared in docs/meri/hermes/phase-1/decisions.md §4 and are carried
-- as configurable defaults in
-- apps/api/src/meri/hermes/meri-hermes-scaling.config.ts. This migration only
-- provides the storage that makes the enforcement ATOMIC and CROSS-REPLICA;
-- it hard-codes no limit.
--
-- Why Postgres and not in-process counters: the API runs as N replicas. An
-- in-process semaphore bounds one replica, so the declared "8 concurrent runs
-- globally" would actually be "8 per replica". Every decision below is taken by
-- a single conditional SQL statement (or, for the capacity gate, inside one
-- advisory-locked transaction), so the outcome is the same no matter how many
-- replicas race it.

-- ---------------------------------------------------------------------------
-- S-1a. Per-tenant, per-UTC-day budget counters.
-- ---------------------------------------------------------------------------
-- `committed_*` is the LIVE exposure compared against the daily cap:
--   committed = Σ(estimate of every OPEN run reservation) + Σ(actual of every
--               RECONCILED run today)
-- Reserve-at-admission moves the estimate in; reconcile-at-terminal swaps the
-- estimate out for the actual. `settled_*` keeps the pure actuals so a report
-- can distinguish "spent" from "currently ring-fenced".
--
-- micro-USD (1e-6 USD) as BIGINT, never a float: money compared against a hard
-- ceiling must not accumulate binary-fraction error across thousands of
-- reservations.
CREATE TABLE "meri_agent_budget_periods" (
  "tenant_id"           UUID NOT NULL,
  "period_date"         DATE NOT NULL,
  "committed_tokens"    BIGINT NOT NULL DEFAULT 0,
  "committed_micro_usd" BIGINT NOT NULL DEFAULT 0,
  "settled_tokens"      BIGINT NOT NULL DEFAULT 0,
  "settled_micro_usd"   BIGINT NOT NULL DEFAULT 0,
  "admitted_runs"       INTEGER NOT NULL DEFAULT 0,
  "settled_runs"        INTEGER NOT NULL DEFAULT 0,
  "refused_admissions"  INTEGER NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meri_agent_budget_periods_pkey" PRIMARY KEY ("tenant_id", "period_date"),
  CONSTRAINT "meri_agent_budget_periods_non_negative_check"
    CHECK ("committed_tokens" >= 0 AND "committed_micro_usd" >= 0
       AND "settled_tokens" >= 0 AND "settled_micro_usd" >= 0),
  CONSTRAINT "meri_agent_budget_periods_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- S-1b. The PARENT reservation: exactly one row per run, primary-keyed by run id.
-- ---------------------------------------------------------------------------
-- This is the object the requirement "every enabled call path draws on the SAME
-- parent reservation" is about. A call path does not get an allowance of its
-- own; it resolves the reservation by the run id it is already working on and
-- draws from `drawn_tokens`. A retry reattaches to the same run id (the
-- (scope_id, idempotency_key) unique constraint on meri_agent_runs guarantees
-- that), so it lands on this same row; a reconciliation poll is given the run
-- id too. There is no code path that can mint a second allowance for one run,
-- because the primary key forbids a second row.
--
-- DELIBERATELY NO FOREIGN KEY to meri_agent_runs. The reservation must be taken
-- and refusable BEFORE a user-visible run row exists, otherwise an exhausted
-- tenant would first get a run record and then have it torn down. The row is
-- keyed by the envelope's pre-minted run id and cleaned up by
-- `sweepAbandoned()` if admission never completes. tenant_id DOES carry an FK,
-- so a deleted tenant takes its reservations with it.
CREATE TABLE "meri_agent_run_reservations" (
  "run_id"              UUID NOT NULL,
  "tenant_id"           UUID NOT NULL,
  "scope_id"            VARCHAR(200) NOT NULL,
  "conversation_id"     UUID NOT NULL,
  "period_date"         DATE NOT NULL,
  "max_run_tokens"      INTEGER NOT NULL,
  "estimated_tokens"    INTEGER NOT NULL,
  "estimated_micro_usd" BIGINT NOT NULL,
  "drawn_tokens"        INTEGER NOT NULL DEFAULT 0,
  "draws"               INTEGER NOT NULL DEFAULT 0,
  -- Per-call-path tally, e.g. {"turn": 3, "status_poll": 1, "retry": 1}. Purely
  -- evidential: it is what lets a test prove three different call paths drew
  -- down ONE counter rather than three.
  "draw_paths_jsonb"    JSONB NOT NULL DEFAULT '{}',
  "actual_tokens"       INTEGER,
  "actual_micro_usd"    BIGINT,
  "state"               VARCHAR(16) NOT NULL DEFAULT 'open',
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconciled_at"       TIMESTAMPTZ(6),
  CONSTRAINT "meri_agent_run_reservations_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "meri_agent_run_reservations_state_check" CHECK ("state" IN ('open','reconciled')),
  CONSTRAINT "meri_agent_run_reservations_drawn_check"
    CHECK ("drawn_tokens" >= 0 AND "draws" >= 0 AND "max_run_tokens" >= 0),
  CONSTRAINT "meri_agent_run_reservations_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "meri_agent_run_reservations_period_idx"
  ON "meri_agent_run_reservations"("tenant_id", "period_date", "state");
CREATE INDEX "meri_agent_run_reservations_open_created_idx"
  ON "meri_agent_run_reservations"("state", "created_at");

-- ---------------------------------------------------------------------------
-- S-2. Fairness: concurrency slots and the bounded per-tenant queue.
-- ---------------------------------------------------------------------------
-- One row per admitted run while it occupies capacity; the row is DELETED on
-- release. `state = 'active'` counts against the global / per-tenant /
-- per-scope concurrency caps; `state = 'queued'` counts against the per-tenant
-- queue depth. Beyond both, admission is refused outright — nothing is ever
-- silently dropped.
--
-- This table deliberately does NOT enforce one-active-run-per-conversation.
-- That invariant already exists and is enforced by the database, in
-- meri_agent_runs (the `meri_agent_runs_conversation_single_writer_idx` partial
-- unique index plus the advisory lock in
-- MeriHermesPrismaRunRepository.create()). Duplicating it here would create two
-- sources of truth for one rule. `conversation_id` is stored for observability
-- and for the queue's actionable conflict message only.
CREATE TABLE "meri_agent_admission_slots" (
  "run_id"          UUID NOT NULL,
  "tenant_id"       UUID NOT NULL,
  "scope_id"        VARCHAR(200) NOT NULL,
  "conversation_id" UUID NOT NULL,
  "state"           VARCHAR(16) NOT NULL,
  "queued_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at"    TIMESTAMPTZ(6),
  -- Liveness for the slot holder. A replica that dies mid-run would otherwise
  -- hold a capacity slot forever; `reapStaleSlots()` removes slots whose
  -- heartbeat has gone stale, which is the same discipline meri_agent_runs
  -- already applies to the consumer lease.
  "heartbeat_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meri_agent_admission_slots_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "meri_agent_admission_slots_state_check" CHECK ("state" IN ('active','queued')),
  CONSTRAINT "meri_agent_admission_slots_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "meri_agent_admission_slots_state_tenant_idx"
  ON "meri_agent_admission_slots"("state", "tenant_id");
CREATE INDEX "meri_agent_admission_slots_state_scope_idx"
  ON "meri_agent_admission_slots"("state", "scope_id");
-- The promotion scan: oldest-waiting first, per decisions.md §4.
CREATE INDEX "meri_agent_admission_slots_queue_order_idx"
  ON "meri_agent_admission_slots"("state", "queued_at");
CREATE INDEX "meri_agent_admission_slots_heartbeat_idx"
  ON "meri_agent_admission_slots"("heartbeat_at");

-- ---------------------------------------------------------------------------
-- S-3. One writer per writable Hermes profile (execution scope).
-- ---------------------------------------------------------------------------
-- Two conversations of the SAME user share one execution scope and therefore
-- one writable Hermes home. Session identity is already separated per
-- conversation by the session key (contracts.md §6 / adapter.sessionKeyFor),
-- so transcripts do not mix; what is NOT separated is the shared writable
-- profile state, where two concurrent read-modify-write updates lose one of
-- the two.
--
-- `fence` is a monotonically increasing token, bumped on every change of
-- holder. A writer presents (holder_run_id, fence) with its write; a writer
-- whose lease expired or was taken over presents a stale pair and is REJECTED
-- at the database rather than being allowed to clobber the new holder's work.
-- Re-acquiring your own live lease does NOT bump the fence, so a holder's own
-- token stays valid across renewals.
CREATE TABLE "meri_agent_profile_leases" (
  "scope_id"      VARCHAR(200) NOT NULL,
  "tenant_id"     UUID NOT NULL,
  "holder_run_id" UUID NOT NULL,
  "fence"         BIGINT NOT NULL DEFAULT 1,
  "acquired_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "renewed_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"    TIMESTAMPTZ(6) NOT NULL,
  "handoffs"      INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "meri_agent_profile_leases_pkey" PRIMARY KEY ("scope_id"),
  CONSTRAINT "meri_agent_profile_leases_fence_check" CHECK ("fence" >= 1),
  CONSTRAINT "meri_agent_profile_leases_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "meri_agent_profile_leases_expiry_idx"
  ON "meri_agent_profile_leases"("expires_at");

-- ---------------------------------------------------------------------------
-- RLS: same canonical shape as 20280920010000_meri_hermes_durable_runs.
-- ENABLE + FORCE, so capiro_app (a member of the table-owner role) cannot fall
-- back on ownership to bypass it. Every tenant-scoped statement therefore runs
-- through PrismaService.withTenant; the genuinely cross-tenant operations (the
-- GLOBAL concurrency count, and the abandoned-reservation sweep) run through
-- withSystem, which sets app.bypass_rls — the same two exceptions the run
-- repository already documents.
-- ---------------------------------------------------------------------------
ALTER TABLE "meri_agent_budget_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_agent_budget_periods" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_agent_budget_periods_isolation" ON "meri_agent_budget_periods"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "meri_agent_run_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_agent_run_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_agent_run_reservations_isolation" ON "meri_agent_run_reservations"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "meri_agent_admission_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_agent_admission_slots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_agent_admission_slots_isolation" ON "meri_agent_admission_slots"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "meri_agent_profile_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_agent_profile_leases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_agent_profile_leases_isolation" ON "meri_agent_profile_leases"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_agent_budget_periods" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_agent_run_reservations" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_agent_admission_slots" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_agent_profile_leases" TO capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "meri_agent_budget_periods" IS
  'Per-tenant per-UTC-day Hermes budget counters. committed_* is the live exposure (open reservations + settled actuals) compared against the declared daily caps; settled_* is the pure actual. Money is micro-USD BIGINT, never floating point.';
COMMENT ON TABLE "meri_agent_run_reservations" IS
  'The single parent token reservation for one run, primary-keyed by run id so no call path (retry, reconciliation poll, compression, child) can obtain a second allowance. Reserved at admission, reconciled against actual usage at terminal.';
COMMENT ON TABLE "meri_agent_admission_slots" IS
  'Concurrency slots and the bounded per-tenant admission queue. Does NOT enforce one-active-run-per-conversation: that invariant lives in meri_agent_runs and is composed with, not duplicated.';
COMMENT ON TABLE "meri_agent_profile_leases" IS
  'One writer per writable Hermes profile (execution scope), with a monotonic fence token. A writer whose lease expired or was taken over presents a stale fence and is rejected at the database.';
