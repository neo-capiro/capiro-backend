CREATE TABLE govinfo_hearing_record_checkpoint (
  source TEXT PRIMARY KEY CHECK (source ~ '^govinfo-chrg:[0-9]+:[0-9]{4}$'),
  cursor JSONB,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  completed_at TIMESTAMPTZ,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  scanned BIGINT NOT NULL DEFAULT 0,
  created BIGINT NOT NULL DEFAULT 0,
  failed BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON govinfo_hearing_record_checkpoint TO capiro_app;
