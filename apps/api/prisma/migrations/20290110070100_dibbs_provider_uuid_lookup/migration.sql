-- A legacy database can contain two spellings of a UUID. Keep both rows and
-- their references so the writer can report the ambiguity for that UUID.
CREATE INDEX "tango_dibbs_solicitation_folded_id_idx"
  ON "tango_dibbs_solicitation" (lower("tango_dibbs_id"));
