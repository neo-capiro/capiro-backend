-- Track who last edited a draft (Clerk user id; nullable for legacy rows).
ALTER TABLE "ws_draft" ADD COLUMN "last_edited_by_id" TEXT;
