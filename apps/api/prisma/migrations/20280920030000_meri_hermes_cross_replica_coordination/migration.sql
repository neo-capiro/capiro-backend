-- Phase 1 closeout ticket #2: cross-replica coordination for Hermes runs.
-- Additive only (three nullable/defaulted columns + one index + two checks).
--
-- Three problems this unblocks, all of which ticket #1 left single-replica:
--
--   1. Pruning-safe recovery. The UI rebuilds assistant text by replaying the
--      event log from `after=0`, which silently breaks once the 5 000-event cap
--      deletes early `message.delta` rows. `output_seq` names the sequence up to
--      which `output` is already an authoritative snapshot: it is written in the
--      SAME transaction as the delta event it names (see the adapter's consume()
--      and MeriHermesRunRepository.append's `tx` parameter), so the snapshot and
--      its cursor can never diverge, and `enforceEventCap` refuses to prune any
--      event with `seq > output_seq`.
--
--   2. Crash takeover. `consumer_id` / `consumer_heartbeat_at` are the lease on
--      "which API replica is currently consuming Hermes's event stream for this
--      run". A non-terminal, dispatched run whose heartbeat is stale can be
--      claimed by another replica with a single conditional UPDATE (see
--      MeriHermesPrismaRunRepository.claimConsumer), so two replicas can never
--      both take over: the loser's UPDATE re-evaluates its WHERE against the
--      winner's committed row and matches zero rows.
--
--   3. Ordered durable polling (`watch()`) needs no new column: it rides the
--      existing `meri_agent_run_events_run_seq_key` unique index on
--      (run_id, seq) for `WHERE run_id = $1 AND seq > $2 ORDER BY seq`.

ALTER TABLE "meri_agent_runs"
  ADD COLUMN "output_seq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "consumer_id" VARCHAR(80),
  ADD COLUMN "consumer_heartbeat_at" TIMESTAMPTZ(6);

-- Deliberately only a non-negativity check, NOT `output_seq <= last_seq`: the
-- ordering between the two is an application invariant (the append that
-- allocates the seq always precedes the update that records it, inside one
-- transaction), and a CHECK that can fire mid-turn would turn a benign ordering
-- slip into a failed user turn. Violations show up as an over-conservative
-- prune, not as data loss.
ALTER TABLE "meri_agent_runs"
  ADD CONSTRAINT "meri_agent_runs_output_seq_check"
  CHECK ("output_seq" >= 0);

-- Takeover scan: non-terminal dispatched runs whose consumer heartbeat went
-- stale. Kept as a PLAIN index (not partial) so it matches the Prisma schema
-- declaration `@@index([consumerHeartbeatAt])` exactly and introduces no drift.
CREATE INDEX "meri_agent_runs_consumer_heartbeat_idx"
  ON "meri_agent_runs" ("consumer_heartbeat_at");

COMMENT ON COLUMN "meri_agent_runs"."output_seq" IS
  'Pruning-safe recovery snapshot: the seq of the last event already represented in "output". Written in the same transaction as that event; enforceEventCap never prunes an event with seq > output_seq, so a client that recovers from (output, output_seq) and then replays seq > output_seq never loses assistant text.';
COMMENT ON COLUMN "meri_agent_runs"."consumer_id" IS
  'Consumer lease owner: the API replica currently consuming the Hermes event stream for this run. Claimed/renewed atomically; a stale heartbeat allows exactly one other replica to take over (MeriHermesPrismaRunRepository.claimConsumer).';
COMMENT ON COLUMN "meri_agent_runs"."consumer_heartbeat_at" IS
  'Liveness heartbeat for the consumer lease. NULL or older than the takeover threshold means the lease is up for grabs; the run is then either resumed from Hermes or finalized honestly as interrupted, never as success.';
