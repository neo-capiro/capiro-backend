-- PR #1604 (5dc41cb8f) added 'pptx' to the application-level AttachmentKind
-- union but never widened this constraint, so every PowerPoint attachment
-- insert fails with a check-constraint violation (23514) at write time.
ALTER TABLE "clio_attachments" DROP CONSTRAINT "clio_attachments_kind_check";
ALTER TABLE "clio_attachments" ADD CONSTRAINT "clio_attachments_kind_check" CHECK ("kind" IN ('pdf', 'docx', 'pptx', 'image', 'text'));
