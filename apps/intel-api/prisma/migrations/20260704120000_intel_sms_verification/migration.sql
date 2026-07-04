-- One-time SMS phone-verification OTP (hashed) — the consent record for the
-- SMS alert channel (P1.1 port of the legacy apps/api sms_verification; D2
-- forbids intel-api writing that table). Additive, intel-owned; no RLS (like
-- other intel_* tables — app-code filters by tenant_id + user_id).
CREATE TABLE "intel_sms_verification" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,                    -- clerk user id
  "client_id" TEXT,                           -- context client (informational)
  "phone" TEXT NOT NULL,                      -- E.164
  "code_hash" TEXT NOT NULL,                  -- SHA-256 of `code:phone`
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed" BOOLEAN NOT NULL DEFAULT false,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intel_sms_verification_pkey" PRIMARY KEY ("id")
);

-- Confirm looks up the latest unconsumed row for (tenant, user, phone).
CREATE INDEX "intel_sms_verification_tenant_id_user_id_phone_idx"
  ON "intel_sms_verification" ("tenant_id", "user_id", "phone");
CREATE INDEX "intel_sms_verification_tenant_id_client_id_idx"
  ON "intel_sms_verification" ("tenant_id", "client_id");
