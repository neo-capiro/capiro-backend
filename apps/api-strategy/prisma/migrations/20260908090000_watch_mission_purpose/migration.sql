ALTER TABLE "sp_agent_mission" ADD COLUMN "purpose" TEXT;
-- ROLLBACK: roll back the application; retain this nullable additive column.
-- Existing missions remain readable by older releases and require no data rewrite.
