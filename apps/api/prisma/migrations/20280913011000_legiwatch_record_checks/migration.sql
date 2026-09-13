CREATE TABLE state_bill_record_check (
  bill_key TEXT NOT NULL REFERENCES state_bill(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('document','vote','action','amendment')),
  source_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','available','partial','failed','metadata_only','review_required')),
  attempted_at TIMESTAMPTZ, checked_at TIMESTAMPTZ, next_check_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, provider_hash TEXT,
  revision_hash TEXT, PRIMARY KEY(bill_key,kind,source_identity)
);
GRANT SELECT,INSERT,UPDATE ON state_bill_record_check TO capiro_app;
REVOKE DELETE,TRUNCATE ON state_bill_record_check FROM capiro_app;
