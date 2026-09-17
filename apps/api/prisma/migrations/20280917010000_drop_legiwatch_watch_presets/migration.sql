-- Drop the LegiWatch W2-4 Watch Presets + backtest feature objects.
--
-- The Watch Presets feature (Create Watch wizard, settings preset card, wave2
-- HTTP endpoints, service, DTOs, and the backtest matcher) has been removed
-- from the codebase. These tables held only per-user preset definitions and
-- their read-only preview jobs — no business records — so no data migration
-- or archival is required.
--
-- Drop order is deliberate:
--   1. public.legiwatch_watch_backtest_job — the ONLY table with an FK into
--      legiwatch_watch_preset (preset_id), verified by FK inspection.
--   2. public.legiwatch_watch_preset
--   3. public.legiwatch_watch_conditions_valid(jsonb) — the CHECK helper used
--      exclusively by legiwatch_watch_preset.conditions; once the table is
--      gone the function has no remaining consumer.
--
-- Indexes, RLS policies, and CHECK/FK constraints are attached to the tables
-- and drop with them implicitly; the GRANTs to capiro_app become void
-- likewise. No CASCADE anywhere: if any unexpected dependent object exists,
-- this migration fails loudly instead of silently dropping it.

DROP TABLE IF EXISTS public.legiwatch_watch_backtest_job;
DROP TABLE IF EXISTS public.legiwatch_watch_preset;
DROP FUNCTION IF EXISTS public.legiwatch_watch_conditions_valid(jsonb);
