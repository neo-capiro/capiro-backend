-- Additive native Meri device-token lifecycle. No existing row changes.
CREATE TABLE "mobile_device_tokens" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "device_id" VARCHAR(128) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "token" TEXT NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "app_version" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "mobile_device_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mobile_device_tokens_environment_check" CHECK ("environment" IN ('sandbox', 'production')),
  CONSTRAINT "mobile_device_tokens_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "mobile_device_tokens_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "mobile_device_tokens_owner_device_env_key"
  ON "mobile_device_tokens"("tenant_id", "user_id", "device_id", "environment");
CREATE INDEX "mobile_device_tokens_owner_active_idx"
  ON "mobile_device_tokens"("tenant_id", "user_id", "revoked_at");
CREATE INDEX "mobile_device_tokens_hash_env_idx"
  ON "mobile_device_tokens"("token_hash", "environment");

ALTER TABLE "mobile_device_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mobile_device_tokens_owner_isolation" ON "mobile_device_tokens"
  USING (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
    )
  );
