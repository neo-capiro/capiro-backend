-- Source-only Objective workload authority. The delegation table is DB-disabled:
-- this migration creates no issuer, signing key, service credential, enabled
-- grant or executable Objective route. Native transaction and privilege proof
-- is required before a later migration may remove the enabled=false fence.
--
-- Core and Strategy use the same Aurora cluster, but Strategy owns sp_draft_job.
-- There is deliberately no cross-owner job FK. The future Core adapter must
-- lock and compare the actual queued job, immutable consent and current source
-- in one transaction before creating a disabled delegation or issuing a token.

CREATE TABLE client_objective_workload_delegations (
  delegation_ref UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  work_action VARCHAR(40) NOT NULL CHECK (work_action='objective.strategy.draft'),
  control_id UUID NOT NULL,
  consent_id UUID NOT NULL,
  control_version INTEGER NOT NULL CHECK (control_version>0),
  generation_job_id UUID NOT NULL,
  generation_request_id UUID NOT NULL,
  generation_request_fingerprint CHAR(64) NOT NULL
    CHECK (generation_request_fingerprint ~ '^[0-9a-f]{64}$'),
  job_request_key TEXT NOT NULL CHECK (job_request_key ~ '^objective-v1:[0-9a-f]{64}$'),
  clerk_user_id VARCHAR(128) NOT NULL CHECK (length(btrim(clerk_user_id))>0),
  service_subject VARCHAR(128) NOT NULL
    CHECK (service_subject='capiro-objective-generation-worker:v1'),
  audience VARCHAR(128) NOT NULL
    CHECK (audience='capiro:objective-strategy-api:v1'),
  policy_revision CHAR(64) NOT NULL CHECK (policy_revision ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  absolute_expires_at TIMESTAMPTZ(6) NOT NULL,
  authority_version INTEGER NOT NULL DEFAULT 1 CHECK (authority_version>0),
  enabled BOOLEAN NOT NULL DEFAULT false CHECK (enabled=false),
  cancelled_at TIMESTAMPTZ(6),
  CONSTRAINT objective_workload_delegations_expiry_check CHECK (
    issued_at<absolute_expires_at
    AND absolute_expires_at<=issued_at+INTERVAL '24 hours'
    AND (cancelled_at IS NULL OR cancelled_at>=issued_at)),
  CONSTRAINT objective_workload_delegations_consent_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,consent_id)
    REFERENCES client_objective_work_consents
    (tenant_id,client_id,objective_id,work_action,control_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_workload_delegations_job_key UNIQUE (generation_job_id),
  CONSTRAINT objective_workload_delegations_consent_request_key UNIQUE
    (tenant_id,consent_id,generation_request_id),
  CONSTRAINT objective_workload_delegations_issuance_scope_key UNIQUE
    (tenant_id,client_id,objective_id,work_action,control_id,consent_id,generation_job_id,delegation_ref)
);
CREATE INDEX objective_workload_delegations_scope_idx ON client_objective_workload_delegations
  (tenant_id,client_id,objective_id,control_id,consent_id);

-- A verified issuance request has one permanent operation decision. A denial
-- is saved even when the job is absent and no tenant can be resolved; a later
-- source change must not turn the same operation or proof into an issuance.
-- Unknown-tenant denial writes require a future narrowly authorized system
-- transaction. No such issuer is mounted by this migration; until its owner
-- and native privileges are reviewed, these failures remain unavailable.
-- This global receipt is deliberately independent of the consent cascade so
-- hard deletion cannot release an old operation_id for reuse.
CREATE TABLE client_objective_workload_issue_decisions (
  operation_id UUID PRIMARY KEY,
  caller_issuer VARCHAR(128) NOT NULL
    CHECK (caller_issuer ~ '^[a-z][a-z0-9:._-]{0,127}$'),
  caller_subject VARCHAR(128) NOT NULL
    CHECK (caller_subject ~ '^[a-z][a-z0-9:._-]{0,127}$'),
  issuance_request_sha256 CHAR(64) NOT NULL
    CHECK (issuance_request_sha256 ~ '^[0-9a-f]{64}$'),
  decision VARCHAR(6) NOT NULL CHECK (decision IN ('issued','denied')),
  resolved_tenant_id UUID,
  generation_job_id UUID,
  phase VARCHAR(32),
  decided_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT objective_workload_issue_decisions_scope_check CHECK (
    (decision='denied' AND generation_job_id IS NULL AND phase IS NULL)
    OR (decision='issued' AND resolved_tenant_id IS NOT NULL
      AND generation_job_id IS NOT NULL AND phase IS NOT NULL)),
  CONSTRAINT objective_workload_issue_decisions_phase_check CHECK (
    phase IS NULL OR phase IN ('admit','admission-read','publish','request-read',
      'accept','complete','completion-read','terminal-account','terminal-read','retained-result-read')),
  CONSTRAINT objective_workload_issue_decisions_proof_key UNIQUE
    (operation_id,caller_issuer,caller_subject,issuance_request_sha256,decision),
  CONSTRAINT objective_workload_issue_decisions_issuance_key UNIQUE
    (operation_id,caller_issuer,caller_subject,issuance_request_sha256,decision,resolved_tenant_id),
  CONSTRAINT objective_workload_issue_decisions_delivery_key UNIQUE
    (operation_id,decision,resolved_tenant_id),
  CONSTRAINT objective_workload_issue_decisions_claim_key UNIQUE
    (operation_id,caller_issuer,caller_subject,issuance_request_sha256,decision,
      resolved_tenant_id,generation_job_id,phase)
);
-- The decision survives consent/issuance deletion, so mutating jobs retain
-- their phase fence even if an inherited owner can DELETE an issuance row.
CREATE UNIQUE INDEX objective_workload_issue_decisions_effect_phase_key
  ON client_objective_workload_issue_decisions (resolved_tenant_id,generation_job_id,phase)
  WHERE decision='issued' AND phase IN ('admit','publish','accept','complete','terminal-account');

-- Persist the original, exact JWT claims rather than a bearer token. A retry
-- of operation_id must compare every saved source, caller and target field and
-- may only reproduce the original, still-live signature using its original
-- signer key. A new operation cannot silently replace an uncertain one.
CREATE TABLE client_objective_workload_issuances (
  operation_id UUID PRIMARY KEY,
  decision VARCHAR(6) NOT NULL DEFAULT 'issued' CHECK (decision='issued'),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  work_action VARCHAR(40) NOT NULL CHECK (work_action='objective.strategy.draft'),
  control_id UUID NOT NULL,
  consent_id UUID NOT NULL,
  generation_job_id UUID NOT NULL,
  delegation_ref UUID NOT NULL,
  caller_issuer VARCHAR(128) NOT NULL CHECK (caller_issuer ~ '^[a-z][a-z0-9:._-]{0,127}$'),
  caller_subject VARCHAR(128) NOT NULL CHECK (caller_subject ~ '^[a-z][a-z0-9:._-]{0,127}$'),
  issuance_request_sha256 CHAR(64) NOT NULL
    CHECK (issuance_request_sha256 ~ '^[0-9a-f]{64}$'),
  authorization_jti UUID NOT NULL,
  token_issuer VARCHAR(128) NOT NULL CHECK (token_issuer ~ '^[a-z][a-z0-9:._-]{0,127}$'),
  token_subject VARCHAR(128) NOT NULL,
  token_audience VARCHAR(128) NOT NULL,
  signer_key_id VARCHAR(64) NOT NULL CHECK (signer_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  phase VARCHAR(32) NOT NULL,
  target_method VARCHAR(4) NOT NULL CHECK (target_method IN ('GET','POST')),
  target_path VARCHAR(256) NOT NULL,
  target_query VARCHAR(1) NOT NULL DEFAULT '' CHECK (target_query=''),
  target_body_sha256 CHAR(64) NOT NULL CHECK (target_body_sha256 ~ '^[0-9a-f]{64}$'),
  attempt_id UUID,
  run_id UUID,
  accepted_binding_sha256 CHAR(64)
    CHECK (accepted_binding_sha256 IS NULL OR accepted_binding_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 CHAR(64)
    CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  iat_seconds BIGINT NOT NULL,
  nbf_seconds BIGINT NOT NULL,
  exp_seconds BIGINT NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT objective_workload_issuances_decision_fk FOREIGN KEY
    (operation_id,caller_issuer,caller_subject,issuance_request_sha256,decision,
      tenant_id,generation_job_id,phase)
    REFERENCES client_objective_workload_issue_decisions
    (operation_id,caller_issuer,caller_subject,issuance_request_sha256,decision,
      resolved_tenant_id,generation_job_id,phase)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT objective_workload_issuances_delegation_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,consent_id,generation_job_id,delegation_ref)
    REFERENCES client_objective_workload_delegations
    (tenant_id,client_id,objective_id,work_action,control_id,consent_id,generation_job_id,delegation_ref)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_workload_issuances_jti_key UNIQUE (authorization_jti),
  CONSTRAINT objective_workload_issuances_proof_scope_key UNIQUE
    (tenant_id,operation_id,caller_issuer,caller_subject,issuance_request_sha256),
  CONSTRAINT objective_workload_issuances_time_check CHECK (
    iat_seconds BETWEEN 0 AND 253402300799
    AND nbf_seconds BETWEEN iat_seconds AND 253402300799
    AND exp_seconds>nbf_seconds AND exp_seconds<=253402300799
    AND exp_seconds-iat_seconds<=60),
  CONSTRAINT objective_workload_issuances_binding_check CHECK (
    (phase IN ('admit','admission-read','publish','request-read')
      AND attempt_id IS NULL AND run_id IS NULL AND accepted_binding_sha256 IS NULL
      AND source_sha256 IS NULL)
    OR (phase IN ('accept','complete','completion-read','terminal-account','terminal-read')
      AND attempt_id IS NOT NULL AND run_id IS NOT NULL AND accepted_binding_sha256 IS NOT NULL
      AND source_sha256 IS NULL)
    OR (phase='retained-result-read'
      AND attempt_id IS NOT NULL AND run_id IS NOT NULL AND accepted_binding_sha256 IS NOT NULL
      AND source_sha256 IS NOT NULL)),
  CONSTRAINT objective_workload_issuances_subject_check CHECK (
    (phase IN ('admit','admission-read','publish','request-read','accept','complete','completion-read')
      AND token_subject='capiro-objective-generation-worker:v1'
      AND token_audience='capiro:objective-strategy-api:v1')
    OR (phase IN ('terminal-account','terminal-read')
      AND token_subject='capiro-objective-terminal-accountant:v1'
      AND token_audience='capiro:objective-strategy-api:v1')
    OR (phase='retained-result-read'
      AND token_subject='capiro-objective-core-result-reader:v1'
      AND token_audience='capiro:objective-meri-retained-result:v1')),
  CONSTRAINT objective_workload_issuances_route_check CHECK (
    (phase='admit' AND target_method='POST'
      AND target_path='/strategy-api/internal/objective-canonical/generation-admissions')
    OR (phase='admission-read' AND target_method='GET'
      AND target_path='/strategy-api/internal/objective-canonical/generation-admissions/'||generation_job_id::text)
    OR (phase='publish' AND target_method='POST'
      AND target_path='/strategy-api/internal/objective-canonical/generation-requests')
    OR (phase='request-read' AND target_method='GET'
      AND target_path='/strategy-api/internal/objective-canonical/generation-requests/'||generation_job_id::text)
    OR (phase='accept' AND target_method='POST'
      AND target_path='/strategy-api/internal/objective-canonical/generation-acceptances')
    OR (phase='complete' AND target_method='POST'
      AND target_path='/strategy-api/internal/objective-canonical/generation-completions')
    OR (phase='completion-read' AND target_method='GET'
      AND target_path='/strategy-api/internal/objective-canonical/generation-completions/'||generation_job_id::text)
    OR (phase='terminal-account' AND target_method='POST'
      AND target_path='/strategy-api/internal/objective-canonical/generation-terminals')
    OR (phase='terminal-read' AND target_method='GET'
      AND target_path='/strategy-api/internal/objective-canonical/generation-terminals/'||generation_job_id::text)
    OR (phase='retained-result-read' AND target_method='POST'
      AND target_path='/v1/internal/objective-generation/retained-result/read')),
  CONSTRAINT objective_workload_issuances_get_body_check CHECK (
    (target_method='GET' AND target_body_sha256=
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    OR (target_method='POST' AND target_body_sha256<>
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'))
);
-- Mutating phases cannot obtain a fresh operation/jti for the same job after
-- an uncertain issuance. Reads can obtain fresh, independently authorized
-- short-lived tokens, but the target still checks source and custody.
CREATE UNIQUE INDEX objective_workload_issuances_effect_phase_key ON client_objective_workload_issuances
  (tenant_id,generation_job_id,phase)
  WHERE phase IN ('admit','publish','accept','complete','terminal-account');
CREATE INDEX objective_workload_issuances_job_idx ON client_objective_workload_issuances
  (tenant_id,generation_job_id,recorded_at);

-- A proof use belongs to the immutable issued OR denied operation decision.
-- For an issued decision, proof_outcome='issued' records consumption for the
-- durable CLAIMED reservation; only deliveries.state='issued' proves that a
-- bearer was finalized for release. A later UNKNOWN leaves the proof spent.
-- It does not FK to the consent-linked issuance: an Objective hard-delete may
-- erase claims, but must never release the consumed proof jti or decision.
-- A denied proof may have a Core-derived tenant and use the tenant transaction.
-- An unknown-tenant denial has NULL tenant and requires a separately reviewed
-- system transaction. The issuer returns a tagged denial from the transaction,
-- commits it, and sends the generic denial afterwards.
CREATE TABLE client_objective_workload_proof_uses (
  tenant_id UUID,
  caller_issuer VARCHAR(128) NOT NULL
    CHECK (caller_issuer ~ '^[a-z][a-z0-9:._-]{0,127}$'),
  caller_subject VARCHAR(128) NOT NULL
    CHECK (caller_subject ~ '^[a-z][a-z0-9:._-]{0,127}$'),
  caller_key_id VARCHAR(64) NOT NULL CHECK (caller_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  proof_jti UUID NOT NULL,
  operation_id UUID NOT NULL,
  operation_decision VARCHAR(6) NOT NULL CHECK (operation_decision IN ('issued','denied')),
  proof_outcome VARCHAR(6) NOT NULL CHECK (proof_outcome IN ('issued','denied')),
  proof_request_sha256 CHAR(64) NOT NULL
    CHECK (proof_request_sha256 ~ '^[0-9a-f]{64}$'),
  proof_iat_seconds BIGINT NOT NULL,
  proof_nbf_seconds BIGINT NOT NULL,
  proof_exp_seconds BIGINT NOT NULL,
  used_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT objective_workload_proof_uses_pkey PRIMARY KEY (caller_issuer,proof_jti),
  CONSTRAINT objective_workload_proof_uses_scope_check CHECK (
    (operation_decision='issued' AND tenant_id IS NOT NULL)
    OR (operation_decision='denied' AND proof_outcome='denied')),
  CONSTRAINT objective_workload_proof_uses_decision_fk FOREIGN KEY
    (operation_id,caller_issuer,caller_subject,proof_request_sha256,operation_decision)
    REFERENCES client_objective_workload_issue_decisions
    (operation_id,caller_issuer,caller_subject,issuance_request_sha256,decision)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  -- This second FK applies when Core resolves a tenant. MATCH SIMPLE skips
  -- it for NULL, so a deferred constraint trigger below compares NULLs too.
  CONSTRAINT objective_workload_proof_uses_tenant_fk FOREIGN KEY
    (operation_id,caller_issuer,caller_subject,proof_request_sha256,operation_decision,tenant_id)
    REFERENCES client_objective_workload_issue_decisions
    (operation_id,caller_issuer,caller_subject,issuance_request_sha256,decision,resolved_tenant_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT objective_workload_proof_uses_time_check CHECK (
    proof_iat_seconds BETWEEN 0 AND 253402300799
    AND proof_nbf_seconds BETWEEN proof_iat_seconds AND 253402300799
    AND proof_exp_seconds>proof_nbf_seconds AND proof_exp_seconds<=253402300799
    AND proof_exp_seconds-proof_iat_seconds<=30)
);
CREATE INDEX objective_workload_proof_uses_operation_idx ON client_objective_workload_proof_uses
  (caller_issuer,operation_id);

-- The immutable claim and its JTI commit before Core invokes its signer. A
-- crash after that commit leaves CLAIMED, which is treated as UNKNOWN on any
-- retry; no new JTI is possible. The delivery row references the permanent
-- decision, never the consent-linked issuance, so hard deletion cannot erase
-- this uncertainty fence. ISSUED keeps only the token digest, not a bearer.
CREATE TABLE client_objective_workload_deliveries (
  operation_id UUID PRIMARY KEY,
  decision VARCHAR(6) NOT NULL DEFAULT 'issued' CHECK (decision='issued'),
  tenant_id UUID NOT NULL,
  authorization_jti UUID NOT NULL,
  state VARCHAR(7) NOT NULL DEFAULT 'claimed'
    CHECK (state IN ('claimed','issued','unknown')),
  token_sha256 CHAR(64)
    CHECK (token_sha256 IS NULL OR token_sha256 ~ '^[0-9a-f]{64}$'),
  claimed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  finalized_at TIMESTAMPTZ(6),
  CONSTRAINT objective_workload_deliveries_decision_fk FOREIGN KEY (operation_id,decision,tenant_id)
    REFERENCES client_objective_workload_issue_decisions
      (operation_id,decision,resolved_tenant_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT objective_workload_deliveries_state_check CHECK (
    (state='claimed' AND token_sha256 IS NULL AND finalized_at IS NULL)
    OR (state='unknown' AND token_sha256 IS NULL AND finalized_at IS NOT NULL)
    OR (state='issued' AND token_sha256 IS NOT NULL AND finalized_at IS NOT NULL)),
  CONSTRAINT objective_workload_deliveries_time_check CHECK (
    finalized_at IS NULL OR finalized_at>=claimed_at)
);
CREATE UNIQUE INDEX objective_workload_deliveries_jti_key
  ON client_objective_workload_deliveries (authorization_jti);

CREATE FUNCTION objective_workload_delivery_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'claimed' OR NEW.state NOT IN ('issued','unknown')
     OR (to_jsonb(NEW)-ARRAY['state','token_sha256','finalized_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','token_sha256','finalized_at']) THEN
    RAISE EXCEPTION 'Objective workload delivery transition refused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER objective_workload_deliveries_transition_guard
  BEFORE UPDATE ON client_objective_workload_deliveries
  FOR EACH ROW EXECUTE FUNCTION objective_workload_delivery_transition_guard();
CREATE TRIGGER objective_workload_deliveries_immutable_delete
  BEFORE DELETE ON client_objective_workload_deliveries
  FOR EACH ROW EXECUTE FUNCTION objective_work_record_immutable();

-- Every proof must have exactly its operation decision's resolved tenant,
-- including NULL for a future system-scoped unknown-tenant denial. The
-- composite FK alone cannot enforce this when proof.tenant_id is NULL.
CREATE FUNCTION objective_workload_proof_use_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM client_objective_workload_issue_decisions d
      WHERE d.operation_id=NEW.operation_id AND d.caller_issuer=NEW.caller_issuer
        AND d.caller_subject=NEW.caller_subject
        AND d.issuance_request_sha256=NEW.proof_request_sha256
        AND d.decision=NEW.operation_decision
        AND NEW.tenant_id IS NOT DISTINCT FROM d.resolved_tenant_id) THEN
    RAISE EXCEPTION 'Objective workload proof tenant differs from operation decision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER objective_workload_proof_uses_tenant_guard
  AFTER INSERT ON client_objective_workload_proof_uses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION objective_workload_proof_use_tenant_guard();

-- The first decision and its issued claim row or denied proof receipt commit
-- together. Later denied proofs for an already-issued operation do not change
-- that operation decision. A consent hard-delete may later remove issuance
-- claims; the independent decision and proof records remain replay fences.
CREATE FUNCTION objective_workload_issue_decision_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision='issued' THEN
    IF NOT EXISTS (SELECT 1 FROM client_objective_workload_issuances i
      WHERE i.operation_id=NEW.operation_id AND i.tenant_id=NEW.resolved_tenant_id
        AND i.generation_job_id=NEW.generation_job_id AND i.phase=NEW.phase
        AND i.caller_issuer=NEW.caller_issuer AND i.caller_subject=NEW.caller_subject
        AND i.issuance_request_sha256=NEW.issuance_request_sha256 AND i.decision='issued') THEN
      RAISE EXCEPTION 'Objective workload issued decision lacks its claim record' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM client_objective_workload_proof_uses p
      WHERE p.operation_id=NEW.operation_id AND p.tenant_id=NEW.resolved_tenant_id
        AND p.caller_issuer=NEW.caller_issuer AND p.caller_subject=NEW.caller_subject
        AND p.proof_request_sha256=NEW.issuance_request_sha256
        AND p.operation_decision='issued' AND p.proof_outcome='issued') THEN
      RAISE EXCEPTION 'Objective workload issued decision lacks its successful proof receipt' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM client_objective_workload_deliveries d
      JOIN client_objective_workload_issuances i ON i.operation_id=d.operation_id
      WHERE d.operation_id=NEW.operation_id AND d.tenant_id=NEW.resolved_tenant_id
        AND d.decision='issued' AND d.state='claimed'
        AND d.authorization_jti=i.authorization_jti) THEN
      RAISE EXCEPTION 'Objective workload issued decision lacks its durable claim' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM client_objective_workload_proof_uses p
      WHERE p.operation_id=NEW.operation_id AND p.caller_issuer=NEW.caller_issuer
        AND p.caller_subject=NEW.caller_subject AND p.proof_request_sha256=NEW.issuance_request_sha256
        AND p.operation_decision='denied' AND p.proof_outcome='denied'
        AND p.tenant_id IS NOT DISTINCT FROM NEW.resolved_tenant_id) THEN
    RAISE EXCEPTION 'Objective workload denied decision lacks its proof receipt' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER objective_workload_issue_decisions_receipt_guard
  AFTER INSERT ON client_objective_workload_issue_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION objective_workload_issue_decision_receipt_guard();

-- A disabled delegation may only advance to cancelled once. All issuance and
-- proof records are immutable; no replay may rewrite the saved claim tuple.
CREATE FUNCTION objective_workload_delegation_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL
     OR NEW.authority_version::BIGINT<>OLD.authority_version::BIGINT+1
     OR (to_jsonb(NEW)-ARRAY['authority_version','cancelled_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['authority_version','cancelled_at']) THEN
    RAISE EXCEPTION 'Objective workload delegation is immutable except cancellation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER objective_workload_delegations_cancel_guard
  BEFORE UPDATE ON client_objective_workload_delegations
  FOR EACH ROW EXECUTE FUNCTION objective_workload_delegation_cancel_guard();
CREATE TRIGGER objective_workload_issue_decisions_immutable
  BEFORE UPDATE OR DELETE ON client_objective_workload_issue_decisions
  FOR EACH ROW EXECUTE FUNCTION objective_work_record_immutable();
CREATE TRIGGER objective_workload_issuances_immutable
  BEFORE UPDATE ON client_objective_workload_issuances
  FOR EACH ROW EXECUTE FUNCTION objective_work_record_immutable();
CREATE TRIGGER objective_workload_proof_uses_immutable
  BEFORE UPDATE OR DELETE ON client_objective_workload_proof_uses
  FOR EACH ROW EXECUTE FUNCTION objective_work_record_immutable();

ALTER TABLE client_objective_workload_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_workload_delegations FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_workload_delegations_isolation ON client_objective_workload_delegations
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE client_objective_workload_issue_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_workload_issue_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_workload_issue_decisions_isolation ON client_objective_workload_issue_decisions
  USING (rls_bypass() OR resolved_tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR resolved_tenant_id=current_tenant_id());
ALTER TABLE client_objective_workload_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_workload_issuances FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_workload_issuances_isolation ON client_objective_workload_issuances
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE client_objective_workload_proof_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_workload_proof_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_workload_proof_uses_isolation ON client_objective_workload_proof_uses
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE client_objective_workload_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_workload_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_workload_deliveries_isolation ON client_objective_workload_deliveries
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());

-- Existing default privileges supply the configured runtime role. Narrow
-- direct destructive grants only; owner inheritance, PUBLIC, effective ACLs
-- and the runtime role's RLS bypass still require native proof before use.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE DELETE,TRUNCATE ON client_objective_workload_delegations FROM capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON client_objective_workload_issue_decisions,
      client_objective_workload_issuances,
      client_objective_workload_proof_uses FROM capiro_app;
    REVOKE DELETE,TRUNCATE ON client_objective_workload_deliveries FROM capiro_app;
    REVOKE UPDATE ON client_objective_workload_deliveries FROM capiro_app;
    GRANT UPDATE (state,token_sha256,finalized_at) ON client_objective_workload_deliveries TO capiro_app;
  END IF;
END $$;
