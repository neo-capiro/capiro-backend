-- Notes Meri's notetaker wrote before notes were saved approved. The notetaker
-- creates the note and then, from the same draft, the debrief linked to its bot
-- session, so the note for a session is the draft note on that meeting by the
-- same author written just before that debrief. (Bot sessions record the
-- debrief id but not the note id.)
UPDATE meeting_notes n
SET status = 'approved',
    approved_at = d.created_at,
    approved_by_user_id = n.author_user_id
FROM meeting_debriefs d
JOIN meeting_bot_sessions s ON s.debrief_id = d.id
WHERE n.tenant_id = d.tenant_id
  AND n.meeting_id = d.meeting_id
  AND n.status = 'draft'
  AND n.author_user_id IS NOT DISTINCT FROM d.author_user_id
  AND n.created_at BETWEEN d.created_at - interval '5 minutes' AND d.created_at + interval '1 minute';
