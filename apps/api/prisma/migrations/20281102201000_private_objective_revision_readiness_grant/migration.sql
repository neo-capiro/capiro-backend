-- meri_private.client_objectives reads the readiness ClientObjectivesService
-- saved in the current revision snapshot. Only the view owner receives these
-- five columns; the reader role gets nothing new. private-sql-admission.ts
-- pins exactly this column set and the table's FORCE RLS tenant policy.
GRANT SELECT (tenant_id, client_id, objective_id, version, snapshot)
  ON public.client_objective_revisions TO capiro_private_projection_owner;
