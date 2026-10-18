-- ARCHIVED SOURCE PROPOSAL ONLY; superseded by the centrally allocated, held
-- 20281018090000_clio_meri_memory_submissions_content_free/migration.sql.
-- Do not execute this proposal. The source at
-- 5c105cf created clio_meri_memory_submissions.candidate JSONB NOT NULL plus
-- clio_meri_memory_submissions_candidate_check. Memory branch 96065ae and Core
-- PR86 b40971b edited that same historical migration to omit both. No applied
-- _prisma_migrations checksum or table-shape readback is available here, so
-- neither edition can be assumed unapplied. Preserve the original migration
-- history, then use a reviewed forward migration for this schema repair.
-- Original 5c105cf file SHA-256: 090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5.
-- Edited 96065ae / PR86 b40971b file SHA-256: b7b6f31cfb887dfe98905088e1229f535702627aa52cb15605ac706a7eabe7bf.
--
-- Release gates: check the applied migration checksum and actual column/check
-- shape in each target DB; confirm receipt payload retention and any holds with
-- the owner; retain review decisions and separately approved canonical memory.
-- Dropping a column is a data disposition action. This source proposal grants
-- no permission to run it or purge rows. Dropping a Postgres column also does
-- not guarantee old bytes are physically erased from existing pages/backups.

BEGIN;

-- Once the release gates are satisfied, remove the redundant payload from the
-- immutable receipt. The existing memory_candidate row owns review payload;
-- the receipt keeps only the candidate digest, proposer and stable review ID.
ALTER TABLE "clio_meri_memory_submissions"
  DROP CONSTRAINT IF EXISTS "clio_meri_memory_submissions_candidate_check";
ALTER TABLE "clio_meri_memory_submissions"
  DROP COLUMN IF EXISTS "candidate";

COMMIT;
