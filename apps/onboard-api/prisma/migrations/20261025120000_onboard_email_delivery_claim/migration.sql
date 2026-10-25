-- Preserve the existing log and its unique dedupe key. New writers commit a
-- claim before SES; existing logs have no reconstructable request payload hash.
ALTER TABLE onboard_email_log
  ADD COLUMN status text NOT NULL DEFAULT 'outcome_unknown',
  ADD COLUMN request_hash text;

UPDATE onboard_email_log
SET status = CASE
  WHEN ses_message_id = 'disabled' THEN 'disabled'
  WHEN ses_message_id IS NOT NULL AND ses_message_id NOT IN ('', 'unknown') THEN 'sent'
  ELSE 'outcome_unknown'
END;

ALTER TABLE onboard_email_log
  ADD CONSTRAINT onboard_email_log_status_check
    CHECK (status IN ('sending', 'sent', 'disabled', 'failed', 'outcome_unknown')),
  ADD CONSTRAINT onboard_email_log_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
