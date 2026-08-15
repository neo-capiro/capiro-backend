-- Funding Opportunities — one outbox row per EVENT, not per delivery.
--
-- WHY THIS EXISTS
-- -------------------------------------------------------------------
-- P46's receiver deliberately accepts the provider's batch envelope,
-- `{ timestamp, events: [...] }`. P48's outbox then stored ONE row per
-- delivery, carrying ONE `external_id` read from `events[0]`.
--
-- So a delivery carrying two events queued one row, resolved the first
-- event's opportunity, and marked itself `done`. The SECOND event — its own
-- opportunity, its own deadline change, possibly critical — was accepted with
-- a 202 and silently discarded. No alert, no error, no quarantine.
--
-- This is the same failure the first independent review found and the fix
-- missed: accepted at one layer, dropped at the next. It was narrowed from
-- "any batch" to "any batch with more than one event" and called closed. The
-- re-review reproduced it: two events in, one alert out.
--
-- WHAT CHANGES
-- -------------------------------------------------------------------
-- `event_index` is the position of the event within its delivery. The
-- idempotency key widens from (delivery_id) to (delivery_id, event_index), so
-- a delivery may enqueue as many rows as it carries events and a REPLAY of
-- that delivery still collapses onto exactly those rows.
--
-- DEFAULT 0 and NOT NULL, so every existing row keeps a stable identity: a
-- single-event delivery is event 0, which is what it always was.
--
-- SAFE TO APPLY. No alert has ever been written in any environment — P48's
-- insert raised `constraint "..." does not exist` on every call until PR #842,
-- which has not been deployed or run anywhere. There is no data whose
-- interpretation this changes.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS or guarded.

ALTER TABLE "tango_event_outbox"
  ADD COLUMN IF NOT EXISTS "event_index" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tango_event_outbox_event_index_chk') THEN
    ALTER TABLE "tango_event_outbox"
      ADD CONSTRAINT "tango_event_outbox_event_index_chk"
      CHECK ("event_index" >= 0);
  END IF;
END $$;

-- The old key made a multi-event delivery unrepresentable. Dropped and
-- replaced rather than added alongside: leaving the single-column unique index
-- in place would reject the second event of every batch, which is the bug.
DROP INDEX IF EXISTS "tango_event_outbox_delivery_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "tango_event_outbox_delivery_event_uniq"
  ON "tango_event_outbox" ("delivery_id", "event_index");

COMMENT ON COLUMN "tango_event_outbox"."event_index" IS
  'Position of this event within its delivery. Part of the idempotency key: a delivery enqueues one row per event it carries, and replaying that delivery collapses onto exactly those rows. 0 for a single-event delivery.';
