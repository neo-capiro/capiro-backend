-- Capture-all becomes a system-wide switch, independent of the Phase 9 cutover
-- ladder: every public hearing on the calendar (federal and state) is captured
-- once the flag is on. The phase transition, production-default and kill-switch
-- guards are unchanged.
ALTER TABLE "legiwatch_cutover_state"
  DROP CONSTRAINT IF EXISTS "legiwatch_cutover_state_capture_all_gate_check";

CREATE OR REPLACE FUNCTION enforce_legiwatch_cutover_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.id <> 'global' OR NEW.id <> 'global' THEN
    RAISE EXCEPTION 'LegiWatch cutover state is a singleton';
  END IF;

  IF NEW.phase <> OLD.phase AND NOT (
    (OLD.phase = 'SHADOW' AND NEW.phase IN ('CANARY', 'ROLLBACK')) OR
    (OLD.phase = 'CANARY' AND NEW.phase IN ('SHADOW', 'READY', 'ROLLBACK')) OR
    (OLD.phase = 'READY' AND NEW.phase IN ('CANARY', 'CUTOVER', 'ROLLBACK')) OR
    (OLD.phase = 'CUTOVER' AND NEW.phase IN ('ROLLBACK')) OR
    (OLD.phase = 'ROLLBACK' AND NEW.phase IN ('SHADOW'))
  ) THEN
    RAISE EXCEPTION 'Illegal LegiWatch cutover transition: % -> %', OLD.phase, NEW.phase;
  END IF;

  IF NEW.production_default AND NEW.phase <> 'CUTOVER' THEN
    RAISE EXCEPTION 'LegiWatch cannot become the production default before CUTOVER';
  END IF;
  IF NOT NEW.kill_switch_engaged AND NEW.phase <> 'CUTOVER' THEN
    RAISE EXCEPTION 'LegiWatch kill switch cannot be disengaged before CUTOVER';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END
$$;

-- Every canonical public proceeding regardless of jurisdiction. Capture-side
-- readers use this instead of federal_committee_hearing (US-only).
CREATE OR REPLACE VIEW capturable_committee_hearing WITH (security_invoker = true) AS
SELECT * FROM committee_hearing
WHERE canonical_hearing_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT ON capturable_committee_hearing TO capiro_app;
  END IF;
END
$$;
