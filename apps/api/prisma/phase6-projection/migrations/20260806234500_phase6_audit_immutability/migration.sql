-- Phase 6 Workstream N/O — harden audit immutability after the base projection schema.
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
     NEW.supersedes_projection_id IS DISTINCT FROM OLD.supersedes_projection_id OR
     NEW.payload_jsonb IS DISTINCT FROM OLD.payload_jsonb
  THEN
    RAISE EXCEPTION 'phase6 immutable proof/provenance fields cannot be mutated';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase6_projection_forbid_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'phase6 audit projections are immutable and cannot be deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS phase6_projection_forbid_delete_trg ON phase6_audit_projection;
CREATE TRIGGER phase6_projection_forbid_delete_trg
BEFORE DELETE ON phase6_audit_projection
FOR EACH ROW EXECUTE FUNCTION phase6_projection_forbid_delete();

CREATE OR REPLACE FUNCTION phase6_cycle_certification_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'phase6 cycle certification rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS phase6_cycle_certification_immutable_update_trg ON phase6_cycle_certification;
CREATE TRIGGER phase6_cycle_certification_immutable_update_trg
BEFORE UPDATE ON phase6_cycle_certification
FOR EACH ROW EXECUTE FUNCTION phase6_cycle_certification_immutable();

DROP TRIGGER IF EXISTS phase6_cycle_certification_immutable_delete_trg ON phase6_cycle_certification;
CREATE TRIGGER phase6_cycle_certification_immutable_delete_trg
BEFORE DELETE ON phase6_cycle_certification
FOR EACH ROW EXECUTE FUNCTION phase6_cycle_certification_immutable();
