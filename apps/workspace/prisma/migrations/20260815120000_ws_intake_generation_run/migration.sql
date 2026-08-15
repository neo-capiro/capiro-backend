-- CreateTable
CREATE TABLE "ws_intake" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "draft_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "blueprint_version_id" UUID NOT NULL,
    "intake_snapshot" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_intake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_generation_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "intake_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "agent_revision" INTEGER NOT NULL DEFAULT 0,
    "lease_holder" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "model" TEXT,
    "reasoning_level" TEXT,
    "section_states" JSONB NOT NULL DEFAULT '{}',
    "stages" JSONB NOT NULL DEFAULT '[]',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_generation_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ws_intake_tenant_id_actor_id_idempotency_key_key" ON "ws_intake"("tenant_id", "actor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ws_intake_draft_id_idx" ON "ws_intake"("draft_id");

-- CreateIndex
CREATE INDEX "ws_intake_run_id_idx" ON "ws_intake"("run_id");

-- CreateIndex
CREATE INDEX "ws_generation_run_tenant_id_status_idx" ON "ws_generation_run"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ws_generation_run_draft_id_idx" ON "ws_generation_run"("draft_id");

-- CreateIndex
CREATE INDEX "ws_generation_run_status_lease_expires_at_idx" ON "ws_generation_run"("status", "lease_expires_at");

-- AddForeignKey
ALTER TABLE "ws_intake" ADD CONSTRAINT "ws_intake_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_intake" ADD CONSTRAINT "ws_intake_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ws_generation_run"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_generation_run" ADD CONSTRAINT "ws_generation_run_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_generation_run" ADD CONSTRAINT "ws_generation_run_intake_id_fkey" FOREIGN KEY ("intake_id") REFERENCES "ws_intake"("id");
