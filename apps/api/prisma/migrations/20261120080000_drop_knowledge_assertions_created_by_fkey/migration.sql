-- Knowledge assertions are immutable factual records. `created_by` is an
-- audit UUID that must survive user deletion (and must not be rewritten by
-- ON DELETE SET NULL). The Prisma schema intentionally has no User relation
-- on KnowledgeAssertion.createdBy for that reason; this migration drops the
-- leftover FK that still pointed at users(id).
--
-- Keep the column. Do not null it. Do not rewrite historical values.

ALTER TABLE "knowledge_assertions"
  DROP CONSTRAINT IF EXISTS "knowledge_assertions_created_by_fkey";

COMMENT ON COLUMN "knowledge_assertions"."created_by" IS
  'Immutable audit UUID of the acting user at assertion creation. Not an FK: user deletion must never mutate historical assertions.';
