-- Phase 4 — confidence as a first-class memory signal (master plan gap #3).
-- Additive + idempotent. Ships DARK: nothing reads memory_items.confidence
-- until MEMORY_CONFIDENCE_WEIGHT>0 (recall fusion) is flipped on a
-- union/projection tenant, and the default recall path is still clio.
--
-- Domain [0,1]; NULL = unscored (legacy/human) and is the NEUTRAL prior at
-- recall (a NULL/unscored row is NEVER demoted — accuracy-first). Low-confidence
-- GATING is a WRITE concern (auto-learn's existing 0.7 floor), not a recall one.

ALTER TABLE "memory_items"     ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;
ALTER TABLE "memory_candidate" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;

-- Range guard (idempotent — house DO-block pattern).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_confidence_chk') THEN
    ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_confidence_chk"
      CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_candidate_confidence_chk') THEN
    ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_confidence_chk"
      CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
  END IF;
END $$;

-- Backfill memory_items from the ONLY existing confidence signal:
-- clio_memory.metadata_jsonb.confidence, over the clio: projection linkage
-- (slug = 'clio:'||cm.id, clioMemorySlug). The tenant-consistent join predicate
-- makes a cross-tenant copy impossible. No fabricated values: only rows that
-- already carry a numeric confidence are touched; everything else stays NULL.
UPDATE "memory_items" mi
   SET "confidence" = LEAST(1, GREATEST(0, (cm."metadata_jsonb" ->> 'confidence')::double precision))
  FROM "clio_memory" cm
 WHERE mi."type" = 'note'
   AND mi."slug" = 'clio:' || cm."id"::text
   AND mi."tenant_id" = cm."tenant_id"
   AND mi."confidence" IS NULL
   AND cm."metadata_jsonb" ? 'confidence'
   AND jsonb_typeof(cm."metadata_jsonb" -> 'confidence') = 'number';

-- Candidate backfill: no-op for existing rows (they predate the field);
-- future-proofs the candidate write path so a re-run is safe.
UPDATE "memory_candidate"
   SET "confidence" = LEAST(1, GREATEST(0, ("payload_jsonb" ->> 'confidence')::double precision))
 WHERE "confidence" IS NULL
   AND "payload_jsonb" ? 'confidence'
   AND jsonb_typeof("payload_jsonb" -> 'confidence') = 'number';

-- ROLLBACK (non-lossy — the source value stays in clio_memory.metadata_jsonb;
-- re-derivable by re-running the backfill):
--   ALTER TABLE memory_items     DROP CONSTRAINT IF EXISTS memory_items_confidence_chk;
--   ALTER TABLE memory_candidate DROP CONSTRAINT IF EXISTS memory_candidate_confidence_chk;
--   ALTER TABLE memory_items     DROP COLUMN IF EXISTS confidence;
--   ALTER TABLE memory_candidate DROP COLUMN IF EXISTS confidence;
