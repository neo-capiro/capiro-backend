CREATE TYPE "research_portfolio_delivery_status" AS ENUM (
  'queued', 'delivered', 'partial', 'failed', 'withheld', 'cancelled', 'outcome_unknown'
);

CREATE TABLE "research_portfolio_subscription_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "channel" VARCHAR(32) NOT NULL,
  "status" "research_portfolio_delivery_status" NOT NULL,
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "checkpoint" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "receipt" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "error_code" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "research_portfolio_subscription_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolio_subscription_deliveries_identity_key"
    UNIQUE ("tenant_id", "subscription_id", "event_id", "recipient_user_id", "channel"),
  CONSTRAINT "research_portfolio_subscription_deliveries_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_subscription_deliveries_portfolio_fkey"
    FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_subscription_deliveries_subscription_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "research_portfolio_subscriptions"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_subscription_deliveries_event_fkey"
    FOREIGN KEY ("tenant_id", "event_id") REFERENCES "research_portfolio_events"("tenant_id", "id") ON DELETE CASCADE
);

CREATE INDEX "research_portfolio_subscription_deliveries_recipient_idx"
  ON "research_portfolio_subscription_deliveries" ("tenant_id", "recipient_user_id", "created_at" DESC);
CREATE INDEX "research_portfolio_subscription_deliveries_status_idx"
  ON "research_portfolio_subscription_deliveries" ("tenant_id", "portfolio_id", "status", "created_at");

ALTER TABLE "research_portfolio_subscription_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "research_portfolio_subscription_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "research_portfolio_subscription_deliveries_tenant_isolation"
  ON "research_portfolio_subscription_deliveries"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON "research_portfolio_subscription_deliveries" TO capiro_app;
GRANT SELECT, INSERT ON "research_portfolio_subscription_deliveries" TO capiro_worker;

CREATE TRIGGER "research_portfolio_subscription_deliveries_append_only"
  BEFORE UPDATE OR DELETE ON "research_portfolio_subscription_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
