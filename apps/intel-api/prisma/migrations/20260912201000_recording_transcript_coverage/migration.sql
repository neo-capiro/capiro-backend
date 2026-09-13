ALTER TABLE intel_hearing_recording_epoch
  ADD COLUMN transcript_state text NOT NULL DEFAULT 'streaming',
  ADD COLUMN transcript_recovery_state text NOT NULL DEFAULT 'none',
  ADD CONSTRAINT recording_epoch_transcript_state CHECK (transcript_state IN ('streaming','partial','finalized')),
  ADD CONSTRAINT recording_epoch_transcript_recovery_state CHECK (transcript_recovery_state IN ('none','pending','processing','ready','failed'));
UPDATE intel_hearing_recording_epoch SET transcript_state=CASE WHEN complete THEN 'finalized' ELSE 'partial' END WHERE state<>'recording';
