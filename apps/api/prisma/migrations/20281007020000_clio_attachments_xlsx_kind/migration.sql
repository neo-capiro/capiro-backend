-- 'xlsx' is in the application-level AttachmentKind union (meri-attachment.helpers.ts)
-- and the upload path validates and extracts workbooks, but this constraint was
-- never widened, so every Excel attachment insert fails with a check-constraint
-- violation (23514) and the upload returns 500 (simplified acceptance case 42).
ALTER TABLE "clio_attachments" DROP CONSTRAINT "clio_attachments_kind_check";
ALTER TABLE "clio_attachments" ADD CONSTRAINT "clio_attachments_kind_check" CHECK ("kind" IN ('pdf', 'docx', 'pptx', 'xlsx', 'image', 'text'));
