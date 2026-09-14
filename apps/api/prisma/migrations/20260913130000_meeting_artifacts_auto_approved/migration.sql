-- Preps and notetaker debriefs no longer wait behind an Approve step; the
-- existing ones stop asking for one too.
UPDATE meeting_preps SET status = 'approved' WHERE status IN ('generated', 'edited');
UPDATE meeting_debriefs SET status = 'approved'
WHERE status IN ('generated', 'edited')
  AND id IN (SELECT debrief_id FROM meeting_bot_sessions WHERE debrief_id IS NOT NULL);
