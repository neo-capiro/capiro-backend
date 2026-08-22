-- LegiWatch Live Hearings — Phase 8 durable live intelligence.
--
-- The public rail is GLOBAL public-record data:
--   canonical transcript segment -> source-grounded public insight.
-- It deliberately has no tenant_id and no RLS. A public insight may only cite
-- canonical public transcript segments and may never contain client, watchlist,
-- mailbox, memory, or tenant context.
--
-- Tenant relevance is a separate, derived rail:
--   public insight + tenant-owned client context -> tenant_hearing_relevance.
-- It is FORCE-RLS isolated and can never mutate the public insight row.
--
-- Two durable queues make both stages restart-safe. The transcript trigger only
-- enqueues a stable segment id; extraction and tenant matching occur out of band.

CREATE TABLE IF NOT EXISTS "public_hearing_insight" (
  "id" TEXT NOT NULL,
  "hearing_id" TEXT NOT NULL,
  "capture_id" TEXT NOT NULL,
  "segment_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "start_ms" INTEGER NOT NULL,
  "end_ms" INTEGER NOT NULL,
  "insight_type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "evidence_text" TEXT,
  "speaker_name" TEXT,
  "confidence" DOUBLE PRECISION,
  "preliminary" BOOLEAN NOT NULL DEFAULT false,
  "entities" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "extractor" TEXT NOT NULL,
  "extractor_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "public_hearing_insight_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_hearing_insight_capture_fk"
    FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE,
  CONSTRAINT "public_hearing_insight_segment_fk"
    FOREIGN KEY ("segment_id") REFERENCES "public_hearing_transcript_segment"("id") ON DELETE CASCADE,
  CONSTRAINT "public_hearing_insight_type_check" CHECK (
    insight_type IN (
      'QUESTION', 'COMMITMENT', 'DEADLINE', 'FUNDING_AMOUNT',
      'BILL_REFERENCE', 'PROGRAM_ELEMENT_REFERENCE', 'AGENCY_REFERENCE',
      'POLICY_POSITION', 'KEY_QUOTE', 'MENTION'
    )
  ),
  CONSTRAINT "public_hearing_insight_offsets_check" CHECK (
    sequence >= 0 AND start_ms >= 0 AND end_ms >= start_ms
  ),
  CONSTRAINT "public_hearing_insight_confidence_check" CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT "public_hearing_insight_entities_array_check" CHECK (
    jsonb_typeof(entities) = 'array'
  )
);

CREATE INDEX IF NOT EXISTS "public_hearing_insight_hearing_sequence_idx"
  ON "public_hearing_insight" ("hearing_id", "sequence", "id");
CREATE INDEX IF NOT EXISTS "public_hearing_insight_segment_idx"
  ON "public_hearing_insight" ("segment_id");
CREATE INDEX IF NOT EXISTS "public_hearing_insight_type_idx"
  ON "public_hearing_insight" ("insight_type", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "public_hearing_insight_entities_gin_idx"
  ON "public_hearing_insight" USING GIN ("entities");

CREATE TABLE IF NOT EXISTS "public_hearing_intelligence_job" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "segment_id" TEXT NOT NULL,
  "capture_id" TEXT NOT NULL,
  "hearing_id" TEXT NOT NULL,
  "segment_revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "due_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "public_hearing_intelligence_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_hearing_intelligence_job_segment_key" UNIQUE ("segment_id"),
  CONSTRAINT "public_hearing_intelligence_job_segment_fk"
    FOREIGN KEY ("segment_id") REFERENCES "public_hearing_transcript_segment"("id") ON DELETE CASCADE,
  CONSTRAINT "public_hearing_intelligence_job_status_check" CHECK (
    status IN ('pending', 'leased', 'completed', 'failed')
  ),
  CONSTRAINT "public_hearing_intelligence_job_attempts_check" CHECK (attempts >= 0),
  CONSTRAINT "public_hearing_intelligence_job_revision_check" CHECK (segment_revision >= 1),
  CONSTRAINT "public_hearing_intelligence_job_lease_check" CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'leased'
  )
);

CREATE INDEX IF NOT EXISTS "public_hearing_intelligence_job_claim_idx"
  ON "public_hearing_intelligence_job" ("status", "due_at", "created_at")
  WHERE status IN ('pending', 'failed', 'leased');
CREATE INDEX IF NOT EXISTS "public_hearing_intelligence_job_hearing_idx"
  ON "public_hearing_intelligence_job" ("hearing_id", "updated_at" DESC);

CREATE TABLE IF NOT EXISTS "tenant_hearing_relevance" (
  "id" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "client_name" TEXT,
  "hearing_id" TEXT NOT NULL,
  "insight_id" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "matched_on" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "rationale" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "tenant_hearing_relevance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_hearing_relevance_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "tenant_hearing_relevance_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE,
  CONSTRAINT "tenant_hearing_relevance_insight_fk"
    FOREIGN KEY ("insight_id") REFERENCES "public_hearing_insight"("id") ON DELETE CASCADE,
  CONSTRAINT "tenant_hearing_relevance_score_check" CHECK (score >= 0 AND score <= 100),
  CONSTRAINT "tenant_hearing_relevance_matched_on_array_check" CHECK (
    jsonb_typeof(matched_on) = 'array'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_hearing_relevance_tenant_client_insight_key"
  ON "tenant_hearing_relevance" ("tenant_id", "client_id", "insight_id");
CREATE INDEX IF NOT EXISTS "tenant_hearing_relevance_tenant_hearing_score_idx"
  ON "tenant_hearing_relevance" ("tenant_id", "hearing_id", "score" DESC, "id");
CREATE INDEX IF NOT EXISTS "tenant_hearing_relevance_tenant_client_idx"
  ON "tenant_hearing_relevance" ("tenant_id", "client_id", "updated_at" DESC);

CREATE TABLE IF NOT EXISTS "tenant_hearing_relevance_job" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "hearing_id" TEXT NOT NULL,
  "public_insight_ids" TEXT[] NOT NULL,
  "batch_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "due_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "tenant_hearing_relevance_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_hearing_relevance_job_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "tenant_hearing_relevance_job_status_check" CHECK (
    status IN ('pending', 'leased', 'completed', 'failed')
  ),
  CONSTRAINT "tenant_hearing_relevance_job_attempts_check" CHECK (attempts >= 0),
  CONSTRAINT "tenant_hearing_relevance_job_insights_check" CHECK (
    cardinality(public_insight_ids) > 0
  ),
  CONSTRAINT "tenant_hearing_relevance_job_lease_check" CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'leased'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_hearing_relevance_job_tenant_batch_key"
  ON "tenant_hearing_relevance_job" ("tenant_id", "batch_key");
CREATE INDEX IF NOT EXISTS "tenant_hearing_relevance_job_claim_idx"
  ON "tenant_hearing_relevance_job" ("status", "due_at", "created_at")
  WHERE status IN ('pending', 'failed', 'leased');
CREATE INDEX IF NOT EXISTS "tenant_hearing_relevance_job_tenant_hearing_idx"
  ON "tenant_hearing_relevance_job" ("tenant_id", "hearing_id", "updated_at" DESC);

ALTER TABLE "tenant_hearing_relevance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_hearing_relevance" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_hearing_relevance_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_hearing_relevance_job" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'tenant_hearing_relevance'
      AND policyname = 'tenant_hearing_relevance_isolation'
  ) THEN
    CREATE POLICY "tenant_hearing_relevance_isolation" ON "tenant_hearing_relevance"
      USING (rls_bypass() OR tenant_id = current_tenant_id())
      WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'tenant_hearing_relevance_job'
      AND policyname = 'tenant_hearing_relevance_job_isolation'
  ) THEN
    CREATE POLICY "tenant_hearing_relevance_job_isolation" ON "tenant_hearing_relevance_job"
      USING (rls_bypass() OR tenant_id = current_tenant_id())
      WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END
$$;

-- The capture writer already commits the canonical segment transactionally.
-- This trigger performs only an idempotent queue write; it does not run an
-- extractor, call a model, or read tenant context on the capture path.
CREATE OR REPLACE FUNCTION enqueue_public_hearing_intelligence_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  canonical_hearing_id TEXT;
BEGIN
  IF NEW.is_final IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  SELECT hearing_id
    INTO canonical_hearing_id
    FROM public_hearing_capture
   WHERE id = NEW.capture_id
   LIMIT 1;

  IF canonical_hearing_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public_hearing_intelligence_job (
    segment_id,
    capture_id,
    hearing_id,
    segment_revision,
    status,
    attempts,
    due_at,
    lease_owner,
    lease_expires_at,
    last_error,
    completed_at,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.capture_id,
    canonical_hearing_id,
    GREATEST(NEW.revision, 1),
    'pending',
    0,
    now(),
    NULL,
    NULL,
    NULL,
    NULL,
    now(),
    now()
  )
  ON CONFLICT (segment_id) DO UPDATE SET
    capture_id = EXCLUDED.capture_id,
    hearing_id = EXCLUDED.hearing_id,
    segment_revision = EXCLUDED.segment_revision,
    status = CASE
      -- Never steal an active lease. The stale worker's revision-fenced write
      -- returns false; completePublic then observes the newer revision and
      -- requeues atomically after releasing the lease.
      WHEN public_hearing_intelligence_job.status = 'leased'
      THEN 'leased'
      WHEN public_hearing_intelligence_job.segment_revision <> EXCLUDED.segment_revision
        OR public_hearing_intelligence_job.status = 'failed'
      THEN 'pending'
      ELSE public_hearing_intelligence_job.status
    END,
    attempts = CASE
      WHEN public_hearing_intelligence_job.status = 'leased'
      THEN public_hearing_intelligence_job.attempts
      WHEN public_hearing_intelligence_job.segment_revision <> EXCLUDED.segment_revision
        OR public_hearing_intelligence_job.status = 'failed'
      THEN 0
      ELSE public_hearing_intelligence_job.attempts
    END,
    due_at = CASE
      WHEN public_hearing_intelligence_job.status = 'leased'
      THEN public_hearing_intelligence_job.due_at
      WHEN public_hearing_intelligence_job.segment_revision <> EXCLUDED.segment_revision
        OR public_hearing_intelligence_job.status = 'failed'
      THEN now()
      ELSE public_hearing_intelligence_job.due_at
    END,
    lease_owner = CASE
      WHEN public_hearing_intelligence_job.status = 'leased'
      THEN public_hearing_intelligence_job.lease_owner
      ELSE NULL
    END,
    lease_expires_at = CASE
      WHEN public_hearing_intelligence_job.status = 'leased'
      THEN public_hearing_intelligence_job.lease_expires_at
      ELSE NULL
    END,
    last_error = CASE
      WHEN public_hearing_intelligence_job.status = 'leased'
      THEN public_hearing_intelligence_job.last_error
      WHEN public_hearing_intelligence_job.segment_revision <> EXCLUDED.segment_revision
        OR public_hearing_intelligence_job.status = 'failed'
      THEN NULL
      ELSE public_hearing_intelligence_job.last_error
    END,
    completed_at = CASE
      WHEN public_hearing_intelligence_job.status = 'leased'
      THEN public_hearing_intelligence_job.completed_at
      WHEN public_hearing_intelligence_job.segment_revision <> EXCLUDED.segment_revision
        OR public_hearing_intelligence_job.status = 'failed'
      THEN NULL
      ELSE public_hearing_intelligence_job.completed_at
    END,
    updated_at = now();

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "public_hearing_transcript_segment_intelligence_enqueue"
  ON "public_hearing_transcript_segment";
CREATE TRIGGER "public_hearing_transcript_segment_intelligence_enqueue"
AFTER INSERT OR UPDATE OF
  "text", "speaker_label", "speaker_confidence",
  "transcription_confidence", "is_final", "revision", "has_gap_before"
ON "public_hearing_transcript_segment"
FOR EACH ROW
EXECUTE FUNCTION enqueue_public_hearing_intelligence_job();

-- Existing final transcript rows become a deterministic backfill queue. No
-- insight is claimed to exist merely because the migration landed.
INSERT INTO public_hearing_intelligence_job (
  segment_id,
  capture_id,
  hearing_id,
  segment_revision,
  status,
  attempts,
  due_at,
  created_at,
  updated_at
)
SELECT
  s.id,
  s.capture_id,
  c.hearing_id,
  GREATEST(s.revision, 1),
  'pending',
  0,
  now(),
  now(),
  now()
FROM public_hearing_transcript_segment s
JOIN public_hearing_capture c ON c.id = s.capture_id
WHERE s.is_final = true
ON CONFLICT (segment_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "public_hearing_insight" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "public_hearing_intelligence_job" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_hearing_relevance" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_hearing_relevance_job" TO capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "public_hearing_insight" IS
  'GLOBAL source-grounded facts derived only from canonical public hearing transcript segments.';
COMMENT ON TABLE "tenant_hearing_relevance" IS
  'FORCE-RLS tenant/client relevance derived from global public hearing insights; never public truth.';
COMMENT ON TABLE "public_hearing_intelligence_job" IS
  'Durable segment extraction queue; one stable job per canonical final transcript segment.';
COMMENT ON TABLE "tenant_hearing_relevance_job" IS
  'Durable FORCE-RLS tenant relevance queue created only after public insight persistence.';
