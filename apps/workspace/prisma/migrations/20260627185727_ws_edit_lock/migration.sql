-- CreateTable
CREATE TABLE "ws_edit_lock" (
    "draft_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "holder_id" TEXT NOT NULL,
    "holder_name" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by_id" TEXT,
    "requested_by_name" TEXT,
    "requested_at" TIMESTAMP(3),

    CONSTRAINT "ws_edit_lock_pkey" PRIMARY KEY ("draft_id")
);

-- CreateIndex
CREATE INDEX "ws_edit_lock_tenant_id_idx" ON "ws_edit_lock"("tenant_id");

-- AddForeignKey
ALTER TABLE "ws_edit_lock" ADD CONSTRAINT "ws_edit_lock_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
