CREATE TABLE intel_legiwatch_news_monitor (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,source_key text NOT NULL,
 source jsonb NOT NULL,config jsonb NOT NULL,version integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'needs_review' CHECK(state IN ('needs_review','paused','active','excluded')),
 baseline_at timestamptz,checkpoint timestamptz,pending_window jsonb,last_attempt_at timestamptz,last_error text,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,source_key)
);
CREATE TABLE intel_legiwatch_news_run (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,monitor_id text NOT NULL,
 definition_version integer NOT NULL,window_start timestamptz NOT NULL,window_end timestamptz NOT NULL,
 page integer NOT NULL,receipt jsonb NOT NULL,complete boolean NOT NULL,successful boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX news_successful_page ON intel_legiwatch_news_run(monitor_id,definition_version,window_start,window_end,page) WHERE successful;
CREATE TABLE intel_legiwatch_news_match (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,monitor_id text NOT NULL,
 definition_version integer NOT NULL,observation_id text NOT NULL,baseline boolean NOT NULL,
 evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(monitor_id,definition_version,observation_id)
);
CREATE TABLE intel_legiwatch_evidence_tracking (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,folder_id text NOT NULL,
 client_id text,kind text NOT NULL CHECK(kind IN ('news','budget','personnel')),source_id text NOT NULL,
 removed boolean NOT NULL DEFAULT false,notes text,version integer NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,owner_clerk_id,folder_id,kind,source_id)
);
CREATE TABLE intel_legiwatch_phase8_decision (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,request_key text NOT NULL,
 input_hash text NOT NULL,outcome jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,owner_clerk_id,request_key)
);
CREATE TABLE intel_legiwatch_editorial_selection (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,folder_id text,client_id text,
 request_key text NOT NULL,input_hash text NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,owner_clerk_id,request_key)
);
CREATE TABLE intel_legiwatch_editorial_config (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,source_key text NOT NULL,
 source jsonb NOT NULL,config jsonb NOT NULL,version integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'needs_review',standing_approval jsonb,last_attempt_at timestamptz,last_success_at timestamptz,last_held_reason text,
 UNIQUE(tenant_id,source_key)
);
CREATE TABLE intel_legiwatch_editorial_occurrence (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,config_id text NOT NULL,
 definition_version integer NOT NULL,occurrence_key text NOT NULL,selection_id text,run_id text,
 state text NOT NULL,payload jsonb NOT NULL,lease_token text,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(config_id,definition_version,occurrence_key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['intel_legiwatch_news_monitor','intel_legiwatch_news_run','intel_legiwatch_news_match','intel_legiwatch_evidence_tracking','intel_legiwatch_phase8_decision','intel_legiwatch_editorial_selection','intel_legiwatch_editorial_config','intel_legiwatch_editorial_occurrence'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY phase8_owner ON %I USING(tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true)) WITH CHECK(tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['intel_legiwatch_news_run','intel_legiwatch_news_match','intel_legiwatch_phase8_decision','intel_legiwatch_editorial_selection'] LOOP
  EXECUTE format('CREATE TRIGGER phase8_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION legiwatch_decision_immutable()',t);
 END LOOP;
END $$;
GRANT UPDATE ON intel_legiwatch_news_monitor,intel_legiwatch_evidence_tracking,intel_legiwatch_editorial_config,intel_legiwatch_editorial_occurrence TO capiro_app;
ALTER TABLE intel_legiwatch_delivery DROP CONSTRAINT report_delivery_kind;
ALTER TABLE intel_legiwatch_delivery ADD CONSTRAINT report_delivery_kind CHECK (
 (kind IN ('bill_report','editorial_brief') AND run_id IS NOT NULL) OR
 (kind IN ('bill_record','agenda','live_update','hearing_recap','record_brief','record_correction','bill_keyword') AND run_id IS NULL));
