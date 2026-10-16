-- CANDIDATE ONLY. Reserved: 20281015040000_engagement_plans.
-- Additive non-Meri manual plan/wave storage; no backfill or live execution.
-- Apply only after coordination with the separate Objective 20281015030000 hunk.
-- Tenant RLS follows Core conventions. Core still owns current membership,
-- ethical-wall authorization, office fences, aggregate versions and audit.

CREATE FUNCTION engagement_plan_office_references_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; target uuid; seen uuid[] := '{}';
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value) > 200 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) <> 'object'
      OR NOT (item ?& ARRAY['targetId','officeKey'])
      OR (item - 'targetId' - 'officeKey') <> '{}'::jsonb
      OR jsonb_typeof(item->'targetId') <> 'string'
      OR jsonb_typeof(item->'officeKey') <> 'string'
      OR (item->>'targetId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (item->>'officeKey') !~ '^(directory|manual):.+'
    THEN RETURN false; END IF;
    target := (item->>'targetId')::uuid;
    IF target = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen, target);
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION engagement_plan_objective_binding_valid(value jsonb, expected_client uuid)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; objective_version numeric;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) <> 'object'
    OR NOT (value ?& ARRAY['clientId','objectiveId','objectiveVersion','objectiveRevisionId'])
    OR (value - 'clientId' - 'objectiveId' - 'objectiveVersion' - 'objectiveRevisionId') <> '{}'::jsonb
  THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['clientId','objectiveId','objectiveRevisionId'] LOOP
    IF jsonb_typeof(value->key) <> 'string'
      OR (value->>key) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN RETURN false; END IF;
  END LOOP;
  IF (value->>'clientId')::uuid <> expected_client
    OR jsonb_typeof(value->'objectiveVersion') <> 'number'
  THEN RETURN false; END IF;
  objective_version := (value->>'objectiveVersion')::numeric;
  RETURN objective_version BETWEEN 1 AND 2147483647
    AND trunc(objective_version) = objective_version;
END $$;

CREATE FUNCTION engagement_plan_window_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE start_day date; end_day date;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) <> 'object'
    OR NOT (value ?& ARRAY['startDate','endDateExclusive','timeZone'])
    OR (value - 'startDate' - 'endDateExclusive' - 'timeZone') <> '{}'::jsonb
    OR jsonb_typeof(value->'startDate') <> 'string'
    OR jsonb_typeof(value->'endDateExclusive') <> 'string'
    OR jsonb_typeof(value->'timeZone') <> 'string'
    OR (value->>'startDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR (value->>'endDateExclusive') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR length(btrim(value->>'timeZone')) = 0
  THEN RETURN false; END IF;
  -- Do not coerce day precision into UTC timestamps. Core validates the admitted
  -- IANA timezone; a database timezone catalogue is not business authority.
  BEGIN
    start_day := (value->>'startDate')::date;
    end_day := (value->>'endDateExclusive')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN false;
  END;
  RETURN end_day > start_day;
END $$;

CREATE FUNCTION engagement_plan_office_target_ids_valid(value uuid[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND cardinality(value) <= 200
    AND (cardinality(value) = 0 OR (array_ndims(value) = 1 AND array_lower(value,1) = 1))
    AND NOT EXISTS (SELECT 1 FROM unnest(value) AS item WHERE item IS NULL)
    AND cardinality(value) = (SELECT count(DISTINCT item) FROM unnest(value) AS item)
$$;

CREATE TABLE engagement_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  title varchar(200) NOT NULL,
  lifecycle varchar(16) NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  office_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  objective_binding jsonb,
  reviewed_plan_version integer,
  reviewed_at timestamptz(6),
  review_due_at timestamptz(6),
  reviewed_by_user_id uuid,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT engagement_plans_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT engagement_plans_client_fk FOREIGN KEY (tenant_id,client_id)
    REFERENCES clients(tenant_id,id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT engagement_plans_scope_key UNIQUE (tenant_id,client_id,id),
  CONSTRAINT engagement_plans_title_check CHECK (length(btrim(title)) > 0),
  CONSTRAINT engagement_plans_lifecycle_check CHECK (lifecycle IN ('draft','active','archived')),
  CONSTRAINT engagement_plans_version_check CHECK (version > 0),
  CONSTRAINT engagement_plans_office_references_check CHECK (engagement_plan_office_references_valid(office_references)),
  CONSTRAINT engagement_plans_objective_binding_check CHECK (engagement_plan_objective_binding_valid(objective_binding,client_id)),
  CONSTRAINT engagement_plans_review_version_check CHECK (reviewed_plan_version IS NULL OR reviewed_plan_version BETWEEN 1 AND version),
  CONSTRAINT engagement_plans_review_metadata_check CHECK (
    (reviewed_plan_version IS NULL AND reviewed_at IS NULL AND review_due_at IS NULL AND reviewed_by_user_id IS NULL)
    OR (reviewed_plan_version IS NOT NULL AND reviewed_at IS NOT NULL AND review_due_at IS NOT NULL
      AND reviewed_by_user_id IS NOT NULL AND reviewed_at < review_due_at)
  )
);
CREATE INDEX engagement_plans_list_idx ON engagement_plans(tenant_id,client_id,lifecycle,created_at);

CREATE TABLE engagement_plan_waves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  title varchar(200) NOT NULL,
  position integer NOT NULL,
  format_label varchar(120),
  "window" jsonb,
  office_target_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  archived_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT engagement_plan_waves_plan_fk FOREIGN KEY (tenant_id,client_id,plan_id)
    REFERENCES engagement_plans(tenant_id,client_id,id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT engagement_plan_waves_title_check CHECK (length(btrim(title)) > 0),
  CONSTRAINT engagement_plan_waves_position_check CHECK (position >= 0),
  CONSTRAINT engagement_plan_waves_format_check CHECK (format_label IS NULL OR length(btrim(format_label)) > 0),
  CONSTRAINT engagement_plan_waves_window_check CHECK (engagement_plan_window_valid("window")),
  CONSTRAINT engagement_plan_waves_offices_check CHECK (engagement_plan_office_target_ids_valid(office_target_ids))
);
CREATE INDEX engagement_plan_waves_list_idx ON engagement_plan_waves(tenant_id,client_id,plan_id,archived_at,position,id);

CREATE TABLE engagement_plan_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  command varchar(32) NOT NULL,
  request_id uuid NOT NULL,
  request_hash char(64) NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT engagement_plan_command_receipts_plan_fk FOREIGN KEY (tenant_id,client_id,plan_id)
    REFERENCES engagement_plans(tenant_id,client_id,id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT engagement_plan_command_receipts_request_key UNIQUE (tenant_id,client_id,actor_user_id,command,request_id),
  CONSTRAINT engagement_plan_command_receipts_command_check CHECK (command IN ('create_plan','create_wave')),
  CONSTRAINT engagement_plan_command_receipts_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engagement_plan_command_receipts_receipt_check CHECK (jsonb_typeof(receipt) = 'object')
);
CREATE INDEX engagement_plan_command_receipts_plan_idx ON engagement_plan_command_receipts(tenant_id,client_id,plan_id);

CREATE TABLE engagement_plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  version integer NOT NULL,
  operation varchar(32) NOT NULL,
  actor_user_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT engagement_plan_revisions_plan_fk FOREIGN KEY (tenant_id,client_id,plan_id)
    REFERENCES engagement_plans(tenant_id,client_id,id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT engagement_plan_revisions_version_key UNIQUE (tenant_id,plan_id,version),
  CONSTRAINT engagement_plan_revisions_version_check CHECK (version > 0),
  CONSTRAINT engagement_plan_revisions_operation_check CHECK (length(btrim(operation)) > 0),
  CONSTRAINT engagement_plan_revisions_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE FUNCTION engagement_plan_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'Engagement plan identity is immutable' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='engagement_plans' THEN
    IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    THEN RAISE EXCEPTION 'Engagement plan creator is immutable' USING ERRCODE='23514'; END IF;
  ELSIF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    RAISE EXCEPTION 'Engagement wave parent is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER engagement_plans_identity_immutable BEFORE UPDATE ON engagement_plans
  FOR EACH ROW EXECUTE FUNCTION engagement_plan_identity_immutable();
CREATE TRIGGER engagement_plan_waves_identity_immutable BEFORE UPDATE ON engagement_plan_waves
  FOR EACH ROW EXECUTE FUNCTION engagement_plan_identity_immutable();

CREATE FUNCTION engagement_plan_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- No direct history deletion or rewrite. A real parent/tenant/client DELETE
  -- has already removed the parent before its FK cascade reaches this row.
  -- Match Core cleanup cascades while retaining unavailable office/user history.
  IF TG_OP='DELETE' AND NOT EXISTS (
    SELECT 1 FROM engagement_plans
    WHERE tenant_id=OLD.tenant_id AND client_id=OLD.client_id AND id=OLD.plan_id
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Engagement plan history is immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER engagement_plan_revisions_immutable BEFORE UPDATE OR DELETE ON engagement_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION engagement_plan_history_immutable();
CREATE TRIGGER engagement_plan_command_receipts_immutable BEFORE UPDATE OR DELETE ON engagement_plan_command_receipts
  FOR EACH ROW EXECUTE FUNCTION engagement_plan_history_immutable();

ALTER TABLE engagement_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY engagement_plans_isolation ON engagement_plans
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE engagement_plan_waves ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_plan_waves FORCE ROW LEVEL SECURITY;
CREATE POLICY engagement_plan_waves_isolation ON engagement_plan_waves
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE engagement_plan_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_plan_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY engagement_plan_command_receipts_isolation ON engagement_plan_command_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE engagement_plan_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_plan_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY engagement_plan_revisions_isolation ON engagement_plan_revisions
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    -- Archive endpoints only. Tenant/client cleanup retains its existing FKs.
    -- Core's default privileges grant DELETE on future tables; GRANT alone
    -- cannot remove it. Revoke parent deletion before granting archive writes.
    REVOKE DELETE ON engagement_plans,engagement_plan_waves FROM capiro_app;
    GRANT SELECT,INSERT,UPDATE ON engagement_plans,engagement_plan_waves TO capiro_app;
    REVOKE UPDATE,DELETE ON engagement_plan_command_receipts,engagement_plan_revisions FROM capiro_app;
    GRANT SELECT,INSERT ON engagement_plan_command_receipts,engagement_plan_revisions TO capiro_app;
  END IF;
END $$;
