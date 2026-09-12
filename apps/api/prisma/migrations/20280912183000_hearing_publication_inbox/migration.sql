ALTER TABLE legiwatch_notification_event ADD COLUMN hearing_publication_id text;
ALTER TABLE legiwatch_notification_event DROP CONSTRAINT legiwatch_notification_event_type_check;
ALTER TABLE legiwatch_notification_event ADD CONSTRAINT legiwatch_notification_event_type_check CHECK (event_type IN (
  'schedule_changed','location_changed','witnesses_changed','hearing_starting','capture_started','capture_failed',
  'transcript_ready','intelligence_ready','high_priority_match','bill_record','agenda_changed','live_update','hearing_recap'
));
ALTER TABLE legiwatch_notification_event DROP CONSTRAINT legiwatch_notification_subject_check;
ALTER TABLE legiwatch_notification_event ADD CONSTRAINT legiwatch_notification_subject_check CHECK (
  (event_type IN ('live_update','hearing_recap') AND hearing_publication_id IS NOT NULL AND bill_id IS NULL) OR
  (event_type='bill_record' AND bill_id IS NOT NULL AND hearing_id IS NULL AND hearing_publication_id IS NULL) OR
  (event_type NOT IN ('live_update','hearing_recap','bill_record') AND hearing_id IS NOT NULL AND bill_id IS NULL AND hearing_publication_id IS NULL)
);
