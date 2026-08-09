-- Phase 3 turn claim: serialize provider turns without holding a DB transaction
-- open across external reasoning/tool latency. This alters only the new Phase 3
-- conversation table; no legacy or Phase 2 campaign-state table is changed.

ALTER TABLE "outreach_reasoning_conversations"
  ADD COLUMN "in_flight_turn_id" UUID,
  ADD COLUMN "in_flight_started_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "outreach_reasoning_conversations_turn_claim_shape_check" CHECK (
    ("in_flight_turn_id" IS NULL AND "in_flight_started_at" IS NULL)
    OR
    ("in_flight_turn_id" IS NOT NULL AND "in_flight_started_at" IS NOT NULL)
  );

CREATE INDEX "outreach_reasoning_conversations_in_flight_idx"
  ON "outreach_reasoning_conversations" ("tenant_id", "in_flight_started_at")
  WHERE "in_flight_turn_id" IS NOT NULL;
