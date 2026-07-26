-- Identity outbox: durable, retryable record of a Clerk-side de-provisioning
-- effect that must eventually land.
--
-- Written in the SAME transaction as the local membership flip to 'removed', so
-- either both happen or neither does. Drained out-of-band by
-- IdentityOutboxWorker, which is the only place the external Clerk call is
-- made — deliberately OUTSIDE any Prisma interactive transaction.

CREATE TABLE "identity_outbox" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "consumed_at" TIMESTAMPTZ(6),
    CONSTRAINT "identity_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "identity_outbox_pending_idx"
    ON "identity_outbox" ("consumed_at", "next_attempt_at");
CREATE INDEX "identity_outbox_tenant_created_idx"
    ON "identity_outbox" ("tenant_id", "created_at");

-- Idempotency: at most ONE unconsumed job per (type, membership). A retried
-- removeMember must not enqueue a second delete for the same membership.
-- Partial unique index, so consumed rows accumulate freely as history.
CREATE UNIQUE INDEX "identity_outbox_pending_unique"
    ON "identity_outbox" ("type", (("payload" ->> 'membershipId')))
    WHERE "consumed_at" IS NULL;

-- Tenant isolation, matching every other tenant-scoped table in this schema.
-- rls_bypass() reads the `app.bypass_rls` GUC (NOT `app.rls_bypass`) and is what
-- PrismaService.withSystem sets; the worker needs it because it drains across
-- tenants.
ALTER TABLE "identity_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity_outbox" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "identity_outbox_isolation" ON "identity_outbox";
CREATE POLICY "identity_outbox_isolation" ON "identity_outbox"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
