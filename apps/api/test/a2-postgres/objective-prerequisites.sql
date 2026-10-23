-- Synthetic scalar subsets used by the actual Objective/Strategy/Planner owners.
-- The four production Objective migrations follow this prerequisite, unchanged.
ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN settings_jsonb jsonb NOT NULL DEFAULT '{"clioFeatureFlags":{"strategyPlanner.enabled":true}}';
CREATE TYPE sp_strategy_type AS ENUM
  ('appropriations','authorization','regulatory','coalition','procurement','earmark','amendment');
CREATE TABLE sp_strategy (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid NOT NULL REFERENCES clients(id),
  title text NOT NULL,type sp_strategy_type NOT NULL,archived_at timestamp(3),updated_at timestamp(3) NOT NULL
);
CREATE TABLE sp_planner_projects (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),owner_id text NOT NULL,
  data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,archived boolean NOT NULL DEFAULT false,
  created_at timestamptz(6) NOT NULL DEFAULT now(),updated_at timestamptz(6) NOT NULL
);
CREATE TABLE sp_planner_tasks (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),owner_id text NOT NULL,
  project_ids uuid[],data jsonb NOT NULL,version integer NOT NULL DEFAULT 1,
  archived boolean NOT NULL DEFAULT false,created_at timestamptz(6) NOT NULL DEFAULT now(),updated_at timestamptz(6) NOT NULL
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sp_strategy','sp_planner_projects','sp_planner_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id())',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON sp_strategy,sp_planner_projects,sp_planner_tasks TO capiro_app;
