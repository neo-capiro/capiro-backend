CREATE UNIQUE INDEX ws_newsletter_document_tenant_key ON ws_newsletter_document(id, tenant_id);
CREATE TABLE ws_newsletter_invitation (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  document_id UUID NOT NULL,
  author_id TEXT NOT NULL,
  request_key UUID NOT NULL,
  email VARCHAR(320) NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
  message TEXT NOT NULL CHECK (length(message) <= 2000),
  source_client_ids UUID[] NOT NULL DEFAULT '{}',
  recipient_id TEXT,
  activated_at TIMESTAMP(3),
  cancelled_at TIMESTAMP(3),
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ws_newsletter_invitation_document_scope_fkey FOREIGN KEY (document_id, tenant_id)
    REFERENCES ws_newsletter_document(id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ws_newsletter_invitation_activation_check CHECK ((recipient_id IS NULL) = (activated_at IS NULL))
);
CREATE UNIQUE INDEX ws_newsletter_invitation_request_key ON ws_newsletter_invitation(tenant_id, author_id, request_key);
CREATE UNIQUE INDEX ws_newsletter_invitation_pending_email_key ON ws_newsletter_invitation(document_id, email)
  WHERE activated_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX ws_newsletter_invitation_tenant_id_document_id_email_idx ON ws_newsletter_invitation(tenant_id, document_id, email);
CREATE INDEX ws_newsletter_invitation_activated_at_created_at_idx ON ws_newsletter_invitation(activated_at, created_at);
