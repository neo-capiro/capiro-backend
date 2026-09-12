ALTER TABLE legiwatch_notification_event DROP CONSTRAINT legiwatch_notification_event_type_check;
ALTER TABLE legiwatch_notification_event ADD CONSTRAINT legiwatch_notification_event_type_check CHECK (event_type IN (
  'schedule_changed','location_changed','witnesses_changed','hearing_starting','capture_started','capture_failed','transcript_ready','intelligence_ready','high_priority_match','bill_record','agenda_changed'
));
