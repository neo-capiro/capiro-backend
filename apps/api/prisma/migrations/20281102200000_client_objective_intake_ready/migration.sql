-- Objectives saved through the shared Strategy intake keep their answers in the
-- immutable revision snapshot and deliberately leave the legacy outcome,
-- government_problem, ask_type and minimum_win columns blank. This row CHECK
-- cannot see that snapshot, so it refused every Request review and Confirm ready
-- for those Objectives (23514, surfaced as a 500). Readiness stays enforced by the
-- only writer, ClientObjectivesService: requireObjectiveReady on the
-- version-checked current row for both shapes, a version-predicated UPDATE, and
-- every edit returning the Objective to draft. Status values remain checked.
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE client_objectives DROP CONSTRAINT client_objectives_ready_check;
COMMIT;
