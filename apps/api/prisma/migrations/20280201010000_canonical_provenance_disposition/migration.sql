-- LegiWatch Phase 9 — generic canonical-provenance disposition.
--
-- ADDITIVE, FORWARD-ONLY.
--
-- Purpose: distinguish (A) canonical events backed by a reconciled official
-- observation, (B) canonical events independently verified as legitimate but
-- with NO retrievable event-level official record in any supported official
-- source, and (C) unexplained provenance gaps. READINESS passes only when
-- category C is empty. A disposition is documented, reviewed evidence —
-- never "we failed to find a page".
--
-- Generic by design: no hearing ids, committee codes, chambers, or event
-- types are encoded in the schema. Source-specific detail lives in `details`.
-- Global operational metadata; no tenant_id (same posture as
-- legiwatch_cutover_run / legiwatch_event_audit).

CREATE TABLE IF NOT EXISTS "canonical_provenance_disposition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "hearing_id" TEXT NOT NULL,
  "disposition_type" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "artifact_uri" TEXT NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "reviewed_by" TEXT NOT NULL,
  "reviewed_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6),
  "revoked_by" TEXT,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "canonical_provenance_disposition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_provenance_disposition_hearing_fk"
    FOREIGN KEY ("hearing_id") REFERENCES "committee_hearing"("id") ON DELETE CASCADE,
  CONSTRAINT "canonical_provenance_disposition_type_check" CHECK (
    disposition_type IN ('OFFICIAL_OBSERVATION_UNAVAILABLE')
  ),
  CONSTRAINT "canonical_provenance_disposition_reason_check" CHECK (
    reason_code IN (
      'CLOSED_BRIEFING_NO_PUBLIC_EVENT_RECORD',
      'OFFICIAL_ARCHIVE_NO_EVENT_RECORD',
      'UPSTREAM_EVENT_RECORD_NOT_PUBLISHED'
    )
  ),
  CONSTRAINT "canonical_provenance_disposition_status_check" CHECK (
    status IN ('ACTIVE', 'SUPERSEDED', 'REVOKED')
  ),
  CONSTRAINT "canonical_provenance_disposition_revoked_shape_check" CHECK (
    -- Exactly: a row carries the durable revocation/supersession stamp
    -- (revoked_by + revoked_at) IF AND ONLY IF it is not ACTIVE. REVOKED and
    -- SUPERSEDED rows must keep their stamp forever; ACTIVE rows have none.
    (status = 'ACTIVE') = (revoked_by IS NULL AND revoked_at IS NULL)
  ),
  CONSTRAINT "canonical_provenance_disposition_artifact_uri_check" CHECK (
    artifact_uri ~* '^https://|^s3://|^arn:'
  ),
  CONSTRAINT "canonical_provenance_disposition_details_check" CHECK (
    jsonb_typeof(details) = 'object'
  ),
  CONSTRAINT "canonical_provenance_disposition_review_shape_check" CHECK (
    reviewed_by <> ''
  ),
  CONSTRAINT "canonical_provenance_disposition_expiry_check" CHECK (
    expires_at IS NULL OR expires_at > reviewed_at
  )
);

-- Exactly one ACTIVE disposition per hearing. A partial index (not a table
-- constraint) so that revocation history — multiple REVOKED/SUPERSEDED rows
-- per hearing — never violates uniqueness; only the live row is unique.
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_provenance_disposition_one_active_idx"
  ON "canonical_provenance_disposition" ("hearing_id")
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS "canonical_provenance_disposition_hearing_idx"
  ON "canonical_provenance_disposition" ("hearing_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "canonical_provenance_disposition_status_idx"
  ON "canonical_provenance_disposition" ("status", "expires_at");

-- ---------------------------------------------------------------------------
-- Self-healing: an observation beats a disposition.
--
-- The Phase 3 provenance trigger stamps a linked observation RECONCILED. When
-- that happens for a hearing that carries an ACTIVE disposition, the
-- disposition is no longer provenance-bearing: the reconciled observation is
-- strictly stronger. The historical row is KEPT (append-only evidence) and
-- marked SUPERSEDED with a durable reason. Readiness treats SUPERSEDED as
-- provenance-neutral history.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION supersede_canonical_provenance_disposition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE "canonical_provenance_disposition"
  SET status = 'SUPERSEDED',
      revoked_by = 'system:reconciled-observation-supersedes',
      revoked_at = now()
  WHERE hearing_id = NEW.hearing_id
    AND status = 'ACTIVE';
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "canonical_provenance_disposition_supersede_guard"
  ON "hearing_source_observation";
CREATE TRIGGER "canonical_provenance_disposition_supersede_guard"
AFTER INSERT OR UPDATE OF "hearing_id"
ON "hearing_source_observation"
FOR EACH ROW
WHEN (NEW.hearing_id IS NOT NULL)
EXECUTE FUNCTION supersede_canonical_provenance_disposition();

REVOKE ALL ON FUNCTION supersede_canonical_provenance_disposition() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "canonical_provenance_disposition" TO capiro_app;
    GRANT EXECUTE ON FUNCTION supersede_canonical_provenance_disposition() TO capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "canonical_provenance_disposition" IS
  'Reviewed, documented provenance dispositions for canonical hearings with no retrievable event-level official observation. Observation provenance always supersedes a disposition (self-healing trigger); historical rows are never deleted.';
