-- Q09 (evidence #127/#129/#133): a 'staff' client target can be either a
-- personal-office staffer (attached to one Member's own office) or real
-- committee staff — these were previously indistinguishable, and the UI
-- hardcoded "Committee Staff" for every one regardless. Additive, nullable —
-- existing rows default to NULL; listTargets() re-resolves this fresh from
-- the directory on every read (see client-targets.service.ts), so existing
-- targets self-heal without needing to be re-added.
ALTER TABLE "client_targets" ADD COLUMN IF NOT EXISTS "staff_kind" VARCHAR(16);
