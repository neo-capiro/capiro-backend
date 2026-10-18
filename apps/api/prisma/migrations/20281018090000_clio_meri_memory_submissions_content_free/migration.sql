-- SOURCE ONLY: this forward migration is held for release review. The original
-- 20281018020000_clio_meri_memory_submissions migration must retain its exact
-- 5c105cfe bytes (SHA-256 090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5).
-- Its candidate JSONB column contains review payload; the pending
-- memory_candidate row is the review owner, while this immutable receipt only
-- needs tenant_id, candidate_id, candidate_sha256, proposer_user_id, review_id
-- and created_at to suppress duplicate submissions after review deletion.
--
-- Before removing the hold below, the release owner must read back each target
-- DB's _prisma_migrations checksum for 020000, actual column/constraint shape,
-- and applicable retention/suppression/hold disposition. Reconcile any
-- different applied checksum before deployment. A column drop is a data
-- disposition action and is not authorized by this source file. Even a
-- successful DROP COLUMN does not erase old pages or backups.

BEGIN;

DO $release_hold$
BEGIN
  RAISE EXCEPTION 'Held source migration 20281018090000: receipt payload disposition requires release review'
    USING ERRCODE = '55000',
          HINT = 'Verify applied 020000 checksum, table shape, retention and holds; authorize the column drop before removing this hold.';
END
$release_hold$;

-- Once the release hold is explicitly removed, the existing memory_candidate
-- row owns review payload; the immutable submission receipt remains for replay.
ALTER TABLE "clio_meri_memory_submissions"
  DROP CONSTRAINT IF EXISTS "clio_meri_memory_submissions_candidate_check";
ALTER TABLE "clio_meri_memory_submissions"
  DROP COLUMN IF EXISTS "candidate";

COMMIT;
