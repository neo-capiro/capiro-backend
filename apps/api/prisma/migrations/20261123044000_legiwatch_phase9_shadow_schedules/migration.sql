-- Shadow comparison must run before canary/cutover. Allow registered discovery,
-- probe, audit, worker and comparison schedules while the product remains in
-- SHADOW. This does not enable production-default UI or capture-all; both remain
-- separately guarded by the singleton state and transition trigger.

ALTER TABLE "legiwatch_cutover_state"
  DROP CONSTRAINT IF EXISTS "legiwatch_cutover_state_schedule_gate_check";

ALTER TABLE "legiwatch_cutover_state"
  ADD CONSTRAINT "legiwatch_cutover_state_schedule_gate_check" CHECK (
    schedules_enabled = false OR phase IN ('SHADOW', 'CANARY', 'READY', 'CUTOVER')
  );
