-- Ledger of identity-rebinding events (email-keyed clerkUserId re-pointing and
-- identity merges). RECORD-ONLY: nothing blocks on it yet — see the model
-- comment in schema.prisma for why gating requires data first.
--
-- No tenant_id column: the middleware self-heal path detects a conflict BEFORE
-- any tenant is resolved. That is also why these events cannot go to audit_logs,
-- whose tenant_id is NOT NULL.

CREATE TABLE "user_identity_conflict" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "incoming_clerk_user_id" TEXT NOT NULL,
    "existing_user_id" UUID NOT NULL,
    "previous_clerk_user_id" TEXT,
    "membership_count" INTEGER NOT NULL DEFAULT 0,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "reviewed_at" TIMESTAMPTZ(6),
    "resolution" TEXT,
    CONSTRAINT "user_identity_conflict_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_identity_conflict_detected_at_idx" ON "user_identity_conflict" ("detected_at");
CREATE INDEX "user_identity_conflict_email_idx" ON "user_identity_conflict" ("email");

-- Cross-tenant by construction (no tenant_id), so it is reachable only from
-- system paths. RLS is enabled with a bypass-only policy so a tenant-scoped
-- connection can never read it.
ALTER TABLE "user_identity_conflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_identity_conflict" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_identity_conflict_system_only" ON "user_identity_conflict";
CREATE POLICY "user_identity_conflict_system_only" ON "user_identity_conflict"
  USING (rls_bypass())
  WITH CHECK (rls_bypass());
