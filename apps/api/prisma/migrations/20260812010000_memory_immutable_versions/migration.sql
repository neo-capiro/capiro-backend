-- MeriV2 closeout Phase 4 — immutable reviewed corrections and restores.
-- Additive guards only. This migration is NOT executed by this branch/task.

-- Version candidates carry a typed payload that names the immutable source row.
-- The source_kind values fit the existing varchar(24) contract.
DO $$ BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_version_payload_check CHECK (
      source_kind NOT IN ('memory_correction','memory_restore','memory_contradiction')
      OR (
        jsonb_typeof(payload_jsonb->'versionProposal') = 'object'
        AND payload_jsonb #>> '{versionProposal,kind}' IN ('correction','restore','contradiction')
        AND COALESCE(payload_jsonb #>> '{versionProposal,sourceItemId}', '') <> ''
      )
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE memory_candidate
  VALIDATE CONSTRAINT memory_candidate_version_payload_check;

-- Generic MemoryCandidateService approval uses an upsert-shaped canonical write.
-- That is valid for a normal save, but forbidden for correction/restore candidates.
-- Only ImmutableMemoryVersionService may set this transaction-local capability
-- after it has locked the rows and completed server-owned authorization.
CREATE OR REPLACE FUNCTION guard_memory_version_candidate_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'pending'
     AND NEW.status IN ('approved','auto_committed')
     AND OLD.source_kind IN ('memory_correction','memory_restore','memory_contradiction')
     AND current_setting('app.memory_version_activation', true) IS DISTINCT FROM 'on'
  THEN
    RAISE EXCEPTION 'memory version candidates require immutable activation service'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_candidate_version_activation_guard ON memory_candidate;
CREATE TRIGGER memory_candidate_version_activation_guard
BEFORE UPDATE OF status ON memory_candidate
FOR EACH ROW
EXECUTE FUNCTION guard_memory_version_candidate_activation();

-- Legal hold is a database boundary, not merely a button state. A held row may be
-- read, confirmed, or used as a historical source for a nondestructive restore,
-- but no code path may revoke or supersede that exact row.
CREATE OR REPLACE FUNCTION guard_held_memory_terminal_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.legal_hold = true
     AND (
       (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('revoked','superseded'))
       OR (
         NEW.governed_status IS DISTINCT FROM OLD.governed_status
         AND NEW.governed_status IN ('revoked','superseded','expired')
       )
     )
  THEN
    RAISE EXCEPTION 'legal-held memory cannot be destructively transitioned'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_items_legal_hold_transition_guard ON memory_items;
CREATE TRIGGER memory_items_legal_hold_transition_guard
BEFORE UPDATE OF status, governed_status ON memory_items
FOR EACH ROW
EXECUTE FUNCTION guard_held_memory_terminal_transition();
