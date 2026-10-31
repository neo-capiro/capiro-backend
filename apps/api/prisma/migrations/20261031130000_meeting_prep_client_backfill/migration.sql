-- WP1 legacy prep attribution: bind unstamped preps to their meeting's client.
--
-- This is a DATA REPAIR, not a schema change. A client-scoped meeting cannot carry a
-- client-agnostic prep, but rows written before that rule existed can have
-- client_id = NULL while meetings.client_id is set, which made them permanently
-- read-only in the UI.
--
-- Idempotent and safe to run twice: after the first run the predicate matches nothing.
-- It does NOT touch rows whose meeting has no client (they keep client_id = NULL and
-- their existing behaviour), and it never re-stamps an already-bound row.
--
-- It must be applied BEFORE the API code that assumes stamped rows is deployed.

UPDATE meeting_preps p
SET client_id = m.client_id,
    updated_at = now()
FROM meetings m
WHERE p.meeting_id = m.id
  AND p.client_id IS NULL
  AND m.client_id IS NOT NULL;
