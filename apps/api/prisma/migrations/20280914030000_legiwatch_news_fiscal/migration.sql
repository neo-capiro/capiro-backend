-- Public evidence owned by API; private queries and relevance stay in Intel.
CREATE TABLE legiwatch_news_observation (
 id text PRIMARY KEY,article_id text NOT NULL REFERENCES intel_article(id),revision text NOT NULL,
 provider text NOT NULL,provider_id text,original_url text NOT NULL,canonical_url text NOT NULL,
 publisher text NOT NULL,author text,provider_parsed_at timestamptz,title text NOT NULL,summary text,body text,body_complete boolean NOT NULL DEFAULT false,
 language text,publisher_country text,article_geography jsonb NOT NULL DEFAULT '[]',
 published_at timestamptz,publication_precision text NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),
 source_url text NOT NULL,rights text NOT NULL CHECK(rights IN ('headline_link','excerpt','full_text')),
 UNIQUE(article_id,revision),CHECK(NOT body_complete OR body IS NOT NULL)
);
CREATE INDEX legiwatch_news_observation_time ON legiwatch_news_observation(observed_at,id);
CREATE TABLE legiwatch_news_current (article_id text PRIMARY KEY REFERENCES intel_article(id),observation_id text NOT NULL REFERENCES legiwatch_news_observation(id),last_observed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE legiwatch_source_receipt (
 id text PRIMARY KEY,source text NOT NULL,source_url text NOT NULL,content_hash text NOT NULL,
 scope jsonb NOT NULL,manifest jsonb NOT NULL,complete boolean NOT NULL,content_bytes bytea,observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legiwatch_source_coverage (
 id text PRIMARY KEY,publisher text NOT NULL,source_group text NOT NULL,source_url text,
 status text NOT NULL CHECK(status IN ('supported','partial','unavailable','excluded')),
 evidence jsonb NOT NULL,owner text NOT NULL,version integer NOT NULL DEFAULT 0
);
CREATE TABLE florida_budget_document (
 id text PRIMARY KEY,publisher text NOT NULL,source_url text NOT NULL,content_hash text NOT NULL,
 title text NOT NULL,fiscal_year text NOT NULL,session_key text NOT NULL,chamber text NOT NULL,
 stage text NOT NULL,role text NOT NULL,offer text,publication_date text,observed_at timestamptz NOT NULL DEFAULT now(),
 receipt_id text NOT NULL REFERENCES legiwatch_source_receipt(id),sections jsonb NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',complete boolean NOT NULL
);
-- A corrected extraction of identical original bytes receives a new immutable
-- document ID. Selection/dispatch checks both the ID and original-byte hash.
CREATE INDEX florida_budget_document_latest ON florida_budget_document(source_url,observed_at DESC,id DESC);
CREATE TABLE florida_budget_project (
 id text PRIMARY KEY,fiscal_year text NOT NULL,title text NOT NULL,agency text,
 identities jsonb NOT NULL,relations jsonb NOT NULL DEFAULT '[]',evidence jsonb NOT NULL
);
CREATE TABLE florida_budget_amount (
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES florida_budget_project(id),
 document_id text NOT NULL REFERENCES florida_budget_document(id),observation jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX florida_budget_amount_project ON florida_budget_amount(project_id,document_id);
CREATE TABLE florida_budget_event (
 id text PRIMARY KEY,project_id text REFERENCES florida_budget_project(id),document_id text NOT NULL REFERENCES florida_budget_document(id),
 kind text NOT NULL CHECK(kind IN ('new_document','amount_change','stage_change','proviso_change','veto_outcome','schedule_revision')),
 payload jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX florida_budget_event_project ON florida_budget_event(project_id,observed_at,id);
CREATE TABLE florida_personnel_observation (
 id text PRIMARY KEY,source_key text NOT NULL,revision text NOT NULL,kind text NOT NULL CHECK(kind IN ('change','registration')),
 name text NOT NULL,branch text,registration_year integer,firm text,principal text,
 old_role text,new_role text,announced_date text,effective_date text,withdrawal_date text,
 confirmation text NOT NULL,canonical_person_id text,directory_url text,
 source_url text NOT NULL,receipt_id text NOT NULL REFERENCES legiwatch_source_receipt(id),
 payload jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_key,revision)
);
CREATE TABLE legiwatch_provider_budget (provider text NOT NULL,day date NOT NULL,requests integer NOT NULL DEFAULT 0,PRIMARY KEY(provider,day));
CREATE VIEW legiwatch_news_source AS SELECT o.*,c.observation_id=o.id AS is_current FROM legiwatch_news_observation o JOIN legiwatch_news_current c ON c.article_id=o.article_id;
CREATE FUNCTION legiwatch_phase8_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PHASE8_EVIDENCE_IMMUTABLE'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['legiwatch_news_observation','legiwatch_source_receipt','florida_budget_document','florida_budget_project','florida_budget_amount','florida_budget_event','florida_personnel_observation'] LOOP
  EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',t);
  EXECUTE format('CREATE TRIGGER phase8_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION legiwatch_phase8_immutable()',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON legiwatch_news_current,legiwatch_source_coverage,legiwatch_provider_budget TO capiro_app;
GRANT SELECT ON legiwatch_news_source TO capiro_app;
