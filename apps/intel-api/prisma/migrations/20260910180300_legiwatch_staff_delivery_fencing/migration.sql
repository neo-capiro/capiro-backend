-- Existing reviewed/shadow records do not become newly eligible on rollout.
ALTER TABLE intel_alert ADD COLUMN delivery_eligible_at TIMESTAMP(3);
ALTER TABLE intel_alert ALTER COLUMN delivery_eligible_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE intel_alert_digest_queue ADD COLUMN lease_token TEXT,
  ADD COLUMN lease_until TIMESTAMP(3), ADD COLUMN dispatch_started_at TIMESTAMP(3);
-- Old flushed rows have no reliable dispatch boundary. Preserve them for
-- explicit reconciliation instead of assuming a provider never accepted them.
UPDATE intel_alert_digest_queue SET dispatch_started_at=created_at,
  last_error='LEGACY_DISPATCH_OUTCOME_UNCONFIRMED'
  WHERE flushed=true AND delivered_at IS NULL;
