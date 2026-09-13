-- Existing tenant-bounded report worker discovers persisted owner scopes. This
-- grants system reads only; mutations still require current tenant and actor.
CREATE POLICY keyword_rule_system_read ON intel_legiwatch_keyword_rule FOR SELECT USING (rls_bypass());
