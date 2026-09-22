-- Additive transition metadata for reviewed budget-line lineage edges.
ALTER TABLE "budget_line_relationship"
ADD COLUMN "transition_fy_from" INTEGER,
ADD COLUMN "transition_fy_to" INTEGER;

COMMENT ON COLUMN "budget_line_relationship"."transition_fy_from" IS
  'Optional fiscal year from which a predecessor/successor transition begins.';
COMMENT ON COLUMN "budget_line_relationship"."transition_fy_to" IS
  'Optional fiscal year in which a predecessor/successor transition lands.';