CREATE TABLE defense_budget_client_watch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('program', 'pe', 'project', 'capability')),
  target_key VARCHAR(160) NOT NULL CHECK (length(trim(target_key)) > 0),
  client_reason TEXT NOT NULL CHECK (length(trim(client_reason)) BETWEEN 1 AND 2000),
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT defense_budget_client_watch_client_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT,
  CONSTRAINT defense_budget_client_watch_user_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT defense_budget_client_watch_target_key UNIQUE (tenant_id, client_id, target_type, target_key)
);
CREATE INDEX defense_budget_client_watch_client_idx ON defense_budget_client_watch(tenant_id, client_id, created_at DESC);

CREATE FUNCTION defense_budget_client_watch_client_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = NEW.client_id AND c.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'watch client scope mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER defense_budget_client_watch_client_scope_before_insert
  BEFORE INSERT ON defense_budget_client_watch
  FOR EACH ROW EXECUTE FUNCTION defense_budget_client_watch_client_scope_guard();

CREATE TABLE defense_budget_client_watch_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  watch_id UUID NOT NULL REFERENCES defense_budget_client_watch(id) ON DELETE RESTRICT,
  event_type VARCHAR(24) NOT NULL CHECK (event_type IN ('subscribed', 'material_update', 'acknowledged', 'dismissed', 'unsubscribed', 'resubscribed')),
  logical_event_key VARCHAR(200) NOT NULL,
  update_event_id UUID REFERENCES defense_budget_client_watch_event(id) ON DELETE RESTRICT,
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  material_reason TEXT,
  evidence JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT defense_budget_client_watch_event_logical_key UNIQUE (watch_id, logical_event_key),
  CONSTRAINT defense_budget_client_watch_event_shape CHECK (
    (event_type = 'material_update' AND update_event_id IS NULL AND material_reason IS NOT NULL AND length(trim(material_reason)) > 0)
    OR (event_type IN ('acknowledged', 'dismissed') AND update_event_id IS NOT NULL AND actor_user_id IS NOT NULL)
    OR (event_type IN ('subscribed', 'unsubscribed', 'resubscribed') AND update_event_id IS NULL AND actor_user_id IS NOT NULL)
  )
);
CREATE INDEX defense_budget_client_watch_event_client_idx ON defense_budget_client_watch_event(tenant_id, client_id, created_at DESC);
CREATE INDEX defense_budget_client_watch_event_update_idx ON defense_budget_client_watch_event(tenant_id, client_id, update_event_id);
CREATE UNIQUE INDEX defense_budget_client_watch_one_decision_per_update
  ON defense_budget_client_watch_event(update_event_id)
  WHERE event_type IN ('acknowledged', 'dismissed');

CREATE FUNCTION defense_budget_client_watch_event_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM defense_budget_client_watch w
    WHERE w.id = NEW.watch_id AND w.tenant_id = NEW.tenant_id AND w.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION 'watch event scope mismatch';
  END IF;
  IF NEW.update_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM defense_budget_client_watch_event e
    WHERE e.id = NEW.update_event_id AND e.watch_id = NEW.watch_id
      AND e.tenant_id = NEW.tenant_id AND e.client_id = NEW.client_id
      AND e.event_type = 'material_update'
  ) THEN
    RAISE EXCEPTION 'watch decision requires same-scope material update';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER defense_budget_client_watch_event_scope_before_insert
  BEFORE INSERT ON defense_budget_client_watch_event
  FOR EACH ROW EXECUTE FUNCTION defense_budget_client_watch_event_scope_guard();

CREATE FUNCTION defense_budget_client_watch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'defense budget client watch history is append only';
END $$;
CREATE TRIGGER defense_budget_client_watch_no_mutation BEFORE UPDATE OR DELETE ON defense_budget_client_watch
  FOR EACH ROW EXECUTE FUNCTION defense_budget_client_watch_immutable();
CREATE TRIGGER defense_budget_client_watch_event_no_mutation BEFORE UPDATE OR DELETE ON defense_budget_client_watch_event
  FOR EACH ROW EXECUTE FUNCTION defense_budget_client_watch_immutable();

ALTER TABLE defense_budget_client_watch ENABLE ROW LEVEL SECURITY;
ALTER TABLE defense_budget_client_watch FORCE ROW LEVEL SECURITY;
CREATE POLICY defense_budget_client_watch_tenant_isolation ON defense_budget_client_watch
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE defense_budget_client_watch_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE defense_budget_client_watch_event FORCE ROW LEVEL SECURITY;
CREATE POLICY defense_budget_client_watch_event_tenant_isolation ON defense_budget_client_watch_event
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
