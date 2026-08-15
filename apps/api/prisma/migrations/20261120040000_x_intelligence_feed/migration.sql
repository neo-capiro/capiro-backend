-- X Intelligence Feed — configurable X/Twitter dashboard feed.
--
-- Global cache tables (x_tracked_account, x_post_cache) store one copy of each
-- tracked X account's posts so all tenants share a single provider fetch.
-- The subscription table (x_feed_subscription) is tenant+user scoped and
-- protected by RLS.

-- Global tracked X account (one row per unique X user, shared across tenants).
CREATE TABLE "x_tracked_account" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "x_user_id" VARCHAR(64) NOT NULL,
  "username" VARCHAR(80) NOT NULL,
  "display_name" VARCHAR(255),
  "avatar_url" TEXT,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "last_post_id" VARCHAR(64),
  "last_fetched_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "x_tracked_account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "x_tracked_account_x_user_id_unique" ON "x_tracked_account"("x_user_id");
CREATE UNIQUE INDEX "x_tracked_account_username_unique" ON "x_tracked_account"("username");
CREATE INDEX "x_tracked_account_last_fetched_idx" ON "x_tracked_account"("last_fetched_at");

-- Cached X posts (one copy per X post, fanned out to subscribers).
CREATE TABLE "x_post_cache" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "account_id" UUID NOT NULL,
  "x_post_id" VARCHAR(64) NOT NULL,
  "text" TEXT NOT NULL,
  "created_at_x" TIMESTAMPTZ(6) NOT NULL,
  "media" JSONB NOT NULL DEFAULT '[]',
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "raw_meta" JSONB NOT NULL DEFAULT '{}',
  "unavailable" BOOLEAN NOT NULL DEFAULT false,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "x_post_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "x_post_cache_account_post_unique" ON "x_post_cache"("account_id", "x_post_id");
CREATE INDEX "x_post_cache_account_created_idx" ON "x_post_cache"("account_id", "created_at_x");
CREATE INDEX "x_post_cache_unavailable_idx" ON "x_post_cache"("unavailable");

ALTER TABLE "x_post_cache" ADD CONSTRAINT "x_post_cache_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "x_tracked_account"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- User subscription to an X account (tenant + user scoped).
CREATE TABLE "x_feed_subscription" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "x_feed_subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "x_feed_subscription_unique" ON "x_feed_subscription"("tenant_id", "user_id", "account_id");
CREATE INDEX "x_feed_subscription_tenant_user_idx" ON "x_feed_subscription"("tenant_id", "user_id");
CREATE INDEX "x_feed_subscription_enabled_idx" ON "x_feed_subscription"("tenant_id", "user_id", "enabled");

ALTER TABLE "x_feed_subscription" ADD CONSTRAINT "x_feed_subscription_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "x_tracked_account"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: subscriptions are isolated by tenant_id. The runtime DB role
-- (capiro_app) bypasses RLS, so the PrismaService tenant-scope query hook
-- is the real enforcement. This policy is belt-and-suspenders for any
-- direct DB access outside the app role.
ALTER TABLE "x_feed_subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "x_feed_subscription" FORCE ROW LEVEL SECURITY;

CREATE POLICY "x_feed_subscription_tenant_isolation" ON "x_feed_subscription"
  USING (tenant_id::text = current_setting('app.current_tenant', true));

CREATE POLICY "x_feed_subscription_tenant_isolation_insert" ON "x_feed_subscription"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));
