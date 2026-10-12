-- Shared authors can edit the newsletter. Access administration stays with
-- its owner; personal assets/templates and Outreach sender permissions retain
-- their existing scopes.
ALTER TABLE ws_newsletter_reviewer DROP CONSTRAINT ws_newsletter_reviewer_role_check;
ALTER TABLE ws_newsletter_reviewer ADD CONSTRAINT ws_newsletter_reviewer_role_check
  CHECK (role IN ('owner', 'viewer', 'commenter', 'editor'));

-- Each authorized author needs a private Outreach handoff. Reusing another
-- author's stage would return a snapshot their mailbox workflow cannot open.
DROP INDEX ws_newsletter_stage_document_id_revision_key;
CREATE UNIQUE INDEX ws_newsletter_stage_document_id_revision_owner_id_key
  ON ws_newsletter_stage(document_id, revision, owner_id);
