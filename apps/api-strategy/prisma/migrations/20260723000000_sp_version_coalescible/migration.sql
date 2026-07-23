-- G3 versioning policy: mark which versions are coalescible field-edit batches.
-- Only these are valid fold targets for a subsequent consecutive same-author
-- field edit (autosave-style); structural events (add/delete/create/restore)
-- and Meri versions are false so they always stand alone in history.
-- Additive + backfilled to false (all pre-G3 versions were discrete cuts).
ALTER TABLE "sp_version" ADD COLUMN "coalescible" BOOLEAN NOT NULL DEFAULT false;
