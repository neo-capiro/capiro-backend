-- Proposal only. Fable assigns the migration number and applies after snapshot.
ALTER TABLE meeting_debriefs ADD COLUMN approved_at timestamptz(6), ADD COLUMN approved_by_user_id uuid;
ALTER TABLE meeting_debriefs ADD CONSTRAINT meeting_debriefs_approved_by_user_id_fkey
  FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE meeting_debriefs VALIDATE CONSTRAINT meeting_debriefs_approved_by_user_id_fkey;
-- Historical approved rows remain NULL: no approval actor/time is fabricated.
