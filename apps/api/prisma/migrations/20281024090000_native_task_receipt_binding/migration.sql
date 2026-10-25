-- Native attended task execution reuses the existing effect receipt and exact
-- approval decision. Historical issuance references remain valid and immutable.
-- Fail on inconsistent historical receipts rather than rewriting their binding.
BEGIN;

ALTER TABLE clio_meri_approval_decisions
  ADD CONSTRAINT clio_meri_approval_decisions_command_key
  UNIQUE (tenant_id, proposal_id, command_sha256);

ALTER TABLE clio_meri_execution_consumptions
  ADD CONSTRAINT clio_meri_execution_consumptions_decision_fkey
  FOREIGN KEY (tenant_id, proposal_id, command_sha256)
  REFERENCES clio_meri_approval_decisions
    (tenant_id, proposal_id, command_sha256)
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE clio_meri_execution_consumptions
  ALTER COLUMN jti DROP NOT NULL;

-- NULL identifies native execution. A non-NULL jti must still reference its
-- historical issuance. The receiver checks current approval and revocation
-- under the existing proposal lock before an effect or replay.
CREATE OR REPLACE FUNCTION clio_meri_execution_consumption_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM 'CLAIMED'
     OR NEW.state IS DISTINCT FROM 'COMPLETED'
     OR ROW(NEW.tenant_id, NEW.proposal_id, NEW.idempotency_key,
            NEW.command_sha256, NEW.arguments_sha256, NEW.jti, NEW.claimed_at)
        IS DISTINCT FROM
        ROW(OLD.tenant_id, OLD.proposal_id, OLD.idempotency_key,
            OLD.command_sha256, OLD.arguments_sha256, OLD.jti, OLD.claimed_at)
  THEN
    RAISE EXCEPTION 'Meri execution consumption may only complete once'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Tenant RLS/FORCE RLS, the effect primary key, result-shape constraint and
-- completion-column UPDATE grant remain unchanged. No issuance grants added.
COMMIT;
