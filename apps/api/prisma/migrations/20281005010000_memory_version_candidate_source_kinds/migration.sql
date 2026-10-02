-- ImmutableMemoryVersionService and the Settings version owner already persist
-- these three typed kinds. Earlier allowlist migrations omitted them, preventing
-- the canonical correction/restore/contradiction review path from starting.
-- Preserve the existing six kinds and all separate approval/lineage/RLS guards.
--
-- Replace both checks in ONE atomic statement. The typed payload must evaluate
-- TRUE: PostgreSQL otherwise accepts UNKNOWN for a missing versionProposal.
-- Do not narrow this allowlist on application rollback after version rows exist.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "memory_candidate"
  DROP CONSTRAINT "memory_candidate_source_kind_chk",
  ADD CONSTRAINT "memory_candidate_source_kind_chk"
    CHECK ("source_kind" IN (
      'explicit_user', 'workflow_event', 'artifact_approval', 'model_extraction',
      'settings_sections', 'learning_signal',
      'memory_correction', 'memory_restore', 'memory_contradiction'
    )),
  DROP CONSTRAINT "memory_candidate_version_payload_check",
  ADD CONSTRAINT "memory_candidate_version_payload_check"
    CHECK (
      source_kind NOT IN ('memory_correction','memory_restore','memory_contradiction')
      OR (
        jsonb_typeof(payload_jsonb->'versionProposal') = 'object'
        AND payload_jsonb #>> '{versionProposal,kind}' IN ('correction','restore','contradiction')
        AND payload_jsonb #>> '{versionProposal,sourceItemId}'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (
          payload_jsonb #>> '{versionProposal,targetItemId}' IS NULL
          OR payload_jsonb #>> '{versionProposal,targetItemId}'
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (
          (source_kind = 'memory_correction'
            AND payload_jsonb #>> '{versionProposal,kind}' = 'correction')
          OR (source_kind = 'memory_restore'
            AND payload_jsonb #>> '{versionProposal,kind}' = 'restore')
          OR (source_kind = 'memory_contradiction'
            AND payload_jsonb #>> '{versionProposal,kind}' = 'contradiction')
        )
      ) IS TRUE
    );

COMMIT;
