-- Phase 6 Workstream O — fail closed on missing JSON keys in terminal-stage projections.
ALTER TABLE phase6_audit_projection DROP CONSTRAINT IF EXISTS phase6_reprogramming_basis_check;
ALTER TABLE phase6_audit_projection ADD CONSTRAINT phase6_reprogramming_basis_check CHECK (
  projection_kind <> 'stage_position' OR stage <> 'reprogramming' OR
  (
    payload_jsonb ? 'revisedTotalBasis' AND
    (
      (direct_or_derived = 'direct' AND payload_jsonb->>'revisedTotalBasis' = 'explicit_after') OR
      (direct_or_derived = 'derived' AND payload_jsonb->>'revisedTotalBasis' = 'policy_derived')
    )
  )
);

ALTER TABLE phase6_audit_projection DROP CONSTRAINT IF EXISTS phase6_execution_semantics_check;
ALTER TABLE phase6_audit_projection ADD CONSTRAINT phase6_execution_semantics_check CHECK (
  projection_kind <> 'stage_position' OR stage <> 'execution' OR
  (
    payload_jsonb ? 'executionMetric' AND
    payload_jsonb ? 'asOfDate' AND
    payload_jsonb ? 'cumulative' AND
    payload_jsonb->>'executionMetric' IN ('obligations','outlays','expenditures','disbursements','commitments','reviewed_other') AND
    payload_jsonb->>'asOfDate' ~ '^\d{4}-\d{2}-\d{2}$' AND
    jsonb_typeof(payload_jsonb->'cumulative') = 'boolean'
  )
);
