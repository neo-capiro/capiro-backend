-- CreateEnum
CREATE TYPE "ws_collaborator_status" AS ENUM ('active', 'pending');

-- CreateTable
CREATE TABLE "ws_collaborator" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "subject_id" TEXT,
    "email" TEXT,
    "name" TEXT,
    "role" "ws_role" NOT NULL,
    "status" "ws_collaborator_status" NOT NULL DEFAULT 'active',
    "invited_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_collaborator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ws_collaborator_draft_id_idx" ON "ws_collaborator"("draft_id");

-- CreateIndex
CREATE INDEX "ws_collaborator_tenant_id_idx" ON "ws_collaborator"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_collaborator_draft_id_subject_id_key" ON "ws_collaborator"("draft_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_collaborator_draft_id_email_key" ON "ws_collaborator"("draft_id", "email");

-- AddForeignKey
ALTER TABLE "ws_collaborator" ADD CONSTRAINT "ws_collaborator_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
