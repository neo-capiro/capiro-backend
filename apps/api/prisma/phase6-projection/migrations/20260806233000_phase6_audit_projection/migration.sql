-- Phase 6 projection/audit-only tables. NONCANONICAL. No product truth table is touched.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS phase6_audit_projection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projection_id text NOT NULL UNIQUE,
  natural_key text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  projection_kind varchar(40) NOT NULL,
  verification_candidate_id text NOT NULL,
  verification_run_id text NOT NULL,
  artifact_id text NOT NULL,
  artifact_content_sha256 char(64) NOT NULL,
  source_document_id text NOT NULL,
  source_pdf_sha256 char(64) NOT NULL,
  source_profile_hash char(64) NOT NULL,
  native_identity_hash char(64) NOT NULL,
  track varchar(32) NOT NULL,
  stage varchar(40) NOT NULL,
  funding_field varchar(40),
  original_value text,
  original_unit varchar(16),
  amount_millions numeric(24,9),
  direct_or_derived varchar(20) NOT NULL,
  evidence_ids_jsonb jsonb NOT NULL,
  binding_status varchar(24) NOT NULL,
  projection_status varchar(24) NOT NULL,
  enactment_proof_id text,
  supersedes_projection_id text,
  payload_jsonb jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phase6_projection_kind_check CHECK (projection_kind IN (
    'vehicle_proof','native_line_binding','stage_position','stage_action','provision_link','enactment_proof','post_enactment_metric'
  )),
  CONSTRAINT phase6_projection_status_check CHECK (projection_status IN ('candidate','verified','blocked','superseded')),
  CONSTRAINT phase6_binding_status_check CHECK (binding_status IN ('accepted','candidate','unresolved','conflicting','not_applicable')),
  CONSTRAINT phase6_directness_check CHECK (direct_or_derived IN ('direct','derived','not_applicable')),
  CONSTRAINT phase6_track_stage_check CHECK (
    (track = 'authorization' AND stage IN ('hasc','sasc','ndaa_conference')) OR
    (track = 'appropriations' AND stage IN ('hac_d','sac_d','appropriations_conference','public_law','continuing_resolution')) OR
    (track = 'post_enactment' AND stage IN ('reprogramming','execution'))
  ),
  CONSTRAINT phase6_stage_field_check CHECK (
    projection_kind <> 'stage_position' OR
    (stage = 'hasc' AND funding_field = 'hascMark') OR
    (stage = 'sasc' AND funding_field = 'sascMark') OR
    (stage = 'ndaa_conference' AND funding_field = 'ndaaConference') OR
    (stage = 'hac_d' AND funding_field = 'hacDMark') OR
    (stage = 'sac_d' AND funding_field = 'sacDMark') OR
    (stage = 'appropriations_conference' AND funding_field = 'conference') OR
    (stage IN ('public_law','continuing_resolution') AND funding_field = 'enacted') OR
    (stage = 'reprogramming' AND funding_field = 'reprogrammed') OR
    (stage = 'execution' AND funding_field = 'executed')
  ),
  CONSTRAINT phase6_verified_binding_check CHECK (
    projection_kind <> 'stage_position' OR projection_status <> 'verified' OR binding_status = 'accepted'
  ),
  CONSTRAINT phase6_enacted_proof_check CHECK (
    projection_kind <> 'stage_position' OR funding_field <> 'enacted' OR enactment_proof_id IS NOT NULL
  ),
  CONSTRAINT phase6_position_money_check CHECK (
    projection_kind <> 'stage_position' OR
    (funding_field IS NOT NULL AND original_value IS NOT NULL AND original_unit IS NOT NULL AND amount_millions IS NOT NULL)
  ),
  CONSTRAINT phase6_cr_line_authority_check CHECK (
    projection_kind <> 'stage_position' OR stage <> 'continuing_resolution' OR
    COALESCE((payload_jsonb->>'explicitLineAuthority')::boolean, false) = true
  ),
  CONSTRAINT phase6_reprogramming_basis_check CHECK (
    projection_kind <> 'stage_position' OR stage <> 'reprogramming' OR
    (
      (direct_or_derived = 'direct' AND payload_jsonb->>'revisedTotalBasis' = 'explicit_after') OR
      (direct_or_derived = 'derived' AND payload_jsonb->>'revisedTotalBasis' = 'policy_derived')
    )
  ),
  CONSTRAINT phase6_execution_semantics_check CHECK (
    projection_kind <> 'stage_position' OR stage <> 'execution' OR
    (
      payload_jsonb->>'executionMetric' IN ('obligations','outlays','expenditures','disbursements','commitments','reviewed_other') AND
      payload_jsonb->>'asOfDate' ~ '^\d{4}-\d{2}-\d{2}$' AND
      jsonb_typeof(payload_jsonb->'cumulative') = 'boolean'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS phase6_projection_live_natural_key
  ON phase6_audit_projection(natural_key)
  WHERE projection_status IN ('candidate','verified');
CREATE INDEX IF NOT EXISTS phase6_projection_verification_run_idx ON phase6_audit_projection(verification_run_id);
CREATE INDEX IF NOT EXISTS phase6_projection_source_document_idx ON phase6_audit_projection(source_document_id);
CREATE INDEX IF NOT EXISTS phase6_projection_stage_field_idx ON phase6_audit_projection(stage, funding_field);

CREATE TABLE IF NOT EXISTS phase6_cycle_certification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id text NOT NULL,
  fiscal_year integer NOT NULL,
  manifest_hash char(64) NOT NULL,
  content_sha256 char(64) NOT NULL UNIQUE,
  status varchar(24) NOT NULL CHECK (status IN ('CERTIFIED','NEEDS_REVIEW','INCOMPLETE','REJECTED')),
  report_jsonb jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phase6_cycle_cert_idempotency_key UNIQUE(cycle_id, content_sha256)
);
CREATE INDEX IF NOT EXISTS phase6_cycle_cert_fy_status_idx ON phase6_cycle_certification(fiscal_year, status);

CREATE OR REPLACE FUNCTION phase6_projection_immutable_proof_fields()
RETURNS trigger AS $$
BEGIN
  IF NEW.projection_id IS DISTINCT FROM OLD.projection_id OR
     NEW.natural_key IS DISTINCT FROM OLD.natural_key OR
     NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
     NEW.projection_kind IS DISTINCT FROM OLD.projection_kind OR
     NEW.verification_candidate_id IS DISTINCT FROM OLD.verification_candidate_id OR
     NEW.verification_run_id IS DISTINCT FROM OLD.verification_run_id OR
     NEW.artifact_id IS DISTINCT FROM OLD.artifact_id OR
     NEW.artifact_content_sha256 IS DISTINCT FROM OLD.artifact_content_sha256 OR
     NEW.source_document_id IS DISTINCT FROM OLD.source_document_id OR
     NEW.source_pdf_sha256 IS DISTINCT FROM OLD.source_pdf_sha256 OR
     NEW.source_profile_hash IS DISTINCT FROM OLD.source_profile_hash OR
     NEW.native_identity_hash IS DISTINCT FROM OLD.native_identity_hash OR
     NEW.track IS DISTINCT FROM OLD.track OR
     NEW.stage IS DISTINCT FROM OLD.stage OR
     NEW.funding_field IS DISTINCT FROM OLD.funding_field OR
     NEW.original_value IS DISTINCT FROM OLD.original_value OR
     NEW.original_unit IS DISTINCT FROM OLD.original_unit OR
     NEW.amount_millions IS DISTINCT FROM OLD.amount_millions OR
     NEW.direct_or_derived IS DISTINCT FROM OLD.direct_or_derived OR
     NEW.evidence_ids_jsonb IS DISTINCT FROM OLD.evidence_ids_jsonb OR
     NEW.binding_status IS DISTINCT FROM OLD.binding_status OR
     NEW.enactment_proof_id IS DISTINCT FROM OLD.enactment_proof_id OR
     NEW.payload_jsonb IS DISTINCT FROM OLD.payload_jsonb
  THEN
    RAISE EXCEPTION 'phase6 immutable proof/provenance fields cannot be mutated';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS phase6_projection_immutable_proof_fields_trg ON phase6_audit_projection;
CREATE TRIGGER phase6_projection_immutable_proof_fields_trg
BEFORE UPDATE ON phase6_audit_projection
FOR EACH ROW EXECUTE FUNCTION phase6_projection_immutable_proof_fields();
