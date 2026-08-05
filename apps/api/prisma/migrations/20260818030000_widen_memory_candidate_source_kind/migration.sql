-- The Settings-editor governed-save flow (MemoryCandidateService.proposeSettingsSections,
-- shipped after 20260712020000_memory_candidate) has always proposed candidates with
-- source_kind='settings_sections' for every firm/client-scope Settings save (Client Soul,
-- Firm Soul, etc.). The original check constraint never included that value, so every
-- such save has been failing outright with a 23514 check-violation -> unhandled Prisma
-- P2010 -> 500, since the day that source_kind was introduced in application code.
ALTER TABLE "memory_candidate" DROP CONSTRAINT "memory_candidate_source_kind_chk";

ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_source_kind_chk"
  CHECK ("source_kind" IN (
    'explicit_user', 'workflow_event', 'artifact_approval', 'model_extraction',
    'settings_sections'
  ));
