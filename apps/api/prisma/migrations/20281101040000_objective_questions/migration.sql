-- Forward-only Objective Questions. Application is owned by the existing DB coordinator.
CREATE TABLE client_objective_questions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status VARCHAR(16) NOT NULL CHECK (status IN ('open','answered','closed')),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  CONSTRAINT client_objective_questions_snapshot CHECK (
    snapshot->>'id'=id::text AND (snapshot->>'version')::int=version AND snapshot->>'status'=status),
  CONSTRAINT client_objective_questions_scope_key UNIQUE (tenant_id,client_id,objective_id,id),
  CONSTRAINT client_objective_questions_objective_fk FOREIGN KEY (tenant_id,client_id,objective_id)
    REFERENCES client_objectives(tenant_id,client_id,id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX client_objective_questions_list_idx ON client_objective_questions(tenant_id,client_id,objective_id,status,id);

CREATE TABLE client_objective_question_revisions (
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  question_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  source_revision_id UUID NOT NULL,
  source_objective_version INTEGER NOT NULL CHECK (source_objective_version > 0),
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  action VARCHAR(16) NOT NULL CHECK (action IN ('create','answer','close','reopen')),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  committed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,client_id,objective_id,question_id,version),
  CONSTRAINT client_objective_question_revisions_request_key UNIQUE(tenant_id,client_id,objective_id,actor_user_id,request_id),
  CONSTRAINT client_objective_question_revisions_snapshot CHECK (
    snapshot->>'id'=question_id::text AND (snapshot->>'version')::int=version
    AND snapshot->>'sourceRevisionId'=source_revision_id::text
    AND (snapshot->>'sourceObjectiveVersion')::int=source_objective_version),
  CONSTRAINT client_objective_question_revisions_question_fk FOREIGN KEY (tenant_id,client_id,objective_id,question_id)
    REFERENCES client_objective_questions(tenant_id,client_id,objective_id,id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT client_objective_question_revisions_source_fk FOREIGN KEY (tenant_id,client_id,objective_id,source_revision_id,source_objective_version)
    REFERENCES client_objective_revisions(tenant_id,client_id,objective_id,id,version) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE FUNCTION objective_question_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Objective Question revision is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER client_objective_question_revisions_immutable BEFORE UPDATE
  ON client_objective_question_revisions FOR EACH ROW EXECUTE FUNCTION objective_question_revision_immutable();

ALTER TABLE client_objective_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objective_questions_isolation ON client_objective_questions
  USING (rls_bypass() OR tenant_id=current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE client_objective_question_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_question_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objective_question_revisions_isolation ON client_objective_question_revisions
  USING (rls_bypass() OR tenant_id=current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT,UPDATE ON client_objective_questions TO capiro_app;
    GRANT SELECT,INSERT ON client_objective_question_revisions TO capiro_app;
    REVOKE DELETE ON client_objective_questions FROM capiro_app;
    REVOKE UPDATE,DELETE ON client_objective_question_revisions FROM capiro_app;
  END IF;
END $$;
