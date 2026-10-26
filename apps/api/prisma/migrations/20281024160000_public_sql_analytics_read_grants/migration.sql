-- Add public analytics SELECT grants without altering role attributes or table definitions.
-- congress_bill already has SELECT in the existing analytics-role migration.
GRANT SELECT ON TABLE
  public.congress_bill_subject,
  public.congress_bill_cosponsor,
  public.congress_member,
  public.program_element,
  public.program_element_project,
  public.program_element_budget_position,
  public.program_element_project_budget_position
TO capiro_analytics_ro;
