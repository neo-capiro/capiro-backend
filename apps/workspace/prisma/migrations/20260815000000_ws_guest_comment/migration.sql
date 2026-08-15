-- Guest comments left on a public /share/:token link (Workspace vNext delivery
-- audit). Guests carry no identity; the record exists purely so the internal
-- team can see client-facing feedback that the public endpoint used to only
-- echo back and discard.

-- CreateTable
CREATE TABLE "ws_guest_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "share_link_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "guest_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_guest_comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ws_guest_comment_tenant_id_draft_id_idx" ON "ws_guest_comment"("tenant_id", "draft_id");

-- CreateIndex
CREATE INDEX "ws_guest_comment_share_link_id_idx" ON "ws_guest_comment"("share_link_id");

-- AddForeignKey
ALTER TABLE "ws_guest_comment" ADD CONSTRAINT "ws_guest_comment_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_guest_comment" ADD CONSTRAINT "ws_guest_comment_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "ws_share_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;
