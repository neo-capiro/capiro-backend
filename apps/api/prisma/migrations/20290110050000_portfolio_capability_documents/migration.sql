-- Reuse Files attachments; a capability association is scoped to its canonical client.
CREATE TABLE client_capability_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capability_documents_identity_key UNIQUE(tenant_id,capability_id,attachment_id),
  FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,client_id,capability_id) REFERENCES client_capabilities(tenant_id,client_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,attachment_id) REFERENCES engagement_attachments(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX capability_documents_subject_idx ON client_capability_documents(tenant_id,client_id);

CREATE FUNCTION validate_capability_document_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM engagement_attachments a
    WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.attachment_id
    AND (a.client_id=NEW.client_id OR EXISTS (
      SELECT 1 FROM profile_attachment_link l WHERE l.tenant_id=a.tenant_id
      AND l.attachment_id=a.id AND l.client_id=NEW.client_id AND l.prospect_id=a.prospect_id
    ))
  ) THEN RAISE EXCEPTION 'Capability document belongs to a different profile' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capability_document_subject BEFORE INSERT OR UPDATE ON client_capability_documents
FOR EACH ROW EXECUTE FUNCTION validate_capability_document_subject();

-- Moving a file changes its owner; old capability links must not travel with it.
-- Trigger authority is limited to links for the changed attachment, not caller-selected rows.
CREATE FUNCTION unlink_moved_capability_document() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM client_capability_documents d
  WHERE d.attachment_id=NEW.id AND d.tenant_id=NEW.tenant_id
    AND d.client_id IS DISTINCT FROM NEW.client_id
    AND NOT EXISTS (SELECT 1 FROM profile_attachment_link l WHERE l.tenant_id=NEW.tenant_id
      AND l.attachment_id=NEW.id AND l.client_id=d.client_id AND l.prospect_id=NEW.prospect_id);
  RETURN NEW;
END $$;
CREATE TRIGGER capability_document_file_move AFTER UPDATE OF client_id,prospect_id ON engagement_attachments
FOR EACH ROW EXECUTE FUNCTION unlink_moved_capability_document();

CREATE FUNCTION unlink_converted_capability_document() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM client_capability_documents d WHERE d.tenant_id=OLD.tenant_id
    AND d.client_id=OLD.client_id AND d.attachment_id=OLD.attachment_id
    AND NOT EXISTS (SELECT 1 FROM engagement_attachments a WHERE a.tenant_id=d.tenant_id
      AND a.id=d.attachment_id AND a.client_id=d.client_id)
    AND NOT EXISTS (SELECT 1 FROM profile_attachment_link l JOIN engagement_attachments a
      ON a.tenant_id=l.tenant_id AND a.id=l.attachment_id AND a.prospect_id=l.prospect_id
      WHERE l.tenant_id=d.tenant_id AND l.client_id=d.client_id AND l.attachment_id=d.attachment_id);
  RETURN OLD;
END $$;
CREATE TRIGGER capability_document_conversion_unlink
AFTER UPDATE OF tenant_id,client_id,prospect_id,attachment_id OR DELETE ON profile_attachment_link
FOR EACH ROW EXECUTE FUNCTION unlink_converted_capability_document();

-- Only existing, usable, correctly scoped source tags become typed associations.
INSERT INTO client_capability_documents(tenant_id,client_id,capability_id,attachment_id)
SELECT c.tenant_id,c.client_id,c.id,a.id FROM client_capabilities c JOIN engagement_attachments a
  ON a.tenant_id=c.tenant_id AND lower(a.source)='capability:'||c.id::text
WHERE a.lifecycle_status IN ('ready','legacy_ready')
  AND (a.client_id=c.client_id OR EXISTS (SELECT 1 FROM profile_attachment_link l
    WHERE l.tenant_id=a.tenant_id AND l.attachment_id=a.id AND l.client_id=c.client_id AND l.prospect_id=a.prospect_id))
ON CONFLICT DO NOTHING;

ALTER TABLE client_capability_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_capability_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_documents_isolation ON client_capability_documents
USING (rls_bypass() OR (tenant_id=current_tenant_id() AND EXISTS (
  SELECT 1 FROM clients c WHERE c.tenant_id=client_capability_documents.tenant_id AND c.id=client_capability_documents.client_id
  AND c.status<>'archived' AND (NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access m
    WHERE m.tenant_id=c.tenant_id AND m.client_id=c.id AND m.user_id=current_user_id()))
)))
WITH CHECK (rls_bypass() OR (tenant_id=current_tenant_id() AND EXISTS (
  SELECT 1 FROM clients c WHERE c.tenant_id=client_capability_documents.tenant_id AND c.id=client_capability_documents.client_id
  AND c.status<>'archived' AND (NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access m
    WHERE m.tenant_id=c.tenant_id AND m.client_id=c.id AND m.user_id=current_user_id()))
)));
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON client_capability_documents TO capiro_app;
END IF; END $$;
