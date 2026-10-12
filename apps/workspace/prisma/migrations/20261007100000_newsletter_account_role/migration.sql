ALTER TABLE ws_newsletter_invitation ADD COLUMN account_role TEXT NOT NULL DEFAULT 'member'
  CHECK (account_role IN ('member', 'admin'));
