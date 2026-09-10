-- Unknown remains NULL for existing records; never backfill from action dates.
ALTER TABLE state_bill ADD COLUMN source_checked_at timestamptz(6),
  ADD COLUMN source_check_attempted_at timestamptz(6),
  ADD COLUMN source_check_status text,
  ADD COLUMN source_check_error text;
ALTER TABLE state_bill ADD CONSTRAINT state_bill_source_check_status_valid
  CHECK (source_check_status IS NULL OR source_check_status IN ('pending','success','partial','failed'));
