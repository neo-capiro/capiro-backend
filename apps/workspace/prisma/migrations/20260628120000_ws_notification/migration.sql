-- CreateEnum
CREATE TYPE "ws_notification_kind" AS ENUM ('collab_invite', 'collab_accepted', 'collab_declined');

-- CreateTable
CREATE TABLE "ws_notification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "kind" "ws_notification_kind" NOT NULL,
    "draft_id" UUID,
    "collaborator_id" UUID,
    "actor_name" TEXT,
    "draft_title" TEXT,
    "role" "ws_role",
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "actionable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ws_notification_tenant_id_recipient_id_idx" ON "ws_notification"("tenant_id", "recipient_id");

-- CreateIndex
CREATE INDEX "ws_notification_recipient_id_read_idx" ON "ws_notification"("recipient_id", "read");
