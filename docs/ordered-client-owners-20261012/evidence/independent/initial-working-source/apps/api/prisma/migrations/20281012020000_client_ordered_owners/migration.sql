-- Source preparation only: not executed, including against ephemeral databases.
-- Reserved after Objectives 20281011010000 and Quick Log 20281012010000.
ALTER TABLE clients ADD COLUMN account_owner_version integer NOT NULL DEFAULT 0
  CONSTRAINT clients_account_owner_version_nonnegative CHECK (account_owner_version >= 0);

CREATE TABLE client_ordered_owners (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 4),
  user_id uuid NOT NULL,
  CONSTRAINT client_ordered_owners_pkey PRIMARY KEY (tenant_id, client_id, rank),
  CONSTRAINT client_ordered_owners_user_unique UNIQUE (tenant_id, client_id, user_id),
  CONSTRAINT client_ordered_owners_client_fk FOREIGN KEY (tenant_id, client_id)
    REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  -- Inactivation/removal of membership retains an unavailable historical owner.
  -- Hard user deletion requires explicit ownership removal first; never promote
  -- another rank or erase the set as an incidental user-delete side effect.
  CONSTRAINT client_ordered_owners_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX client_ordered_owners_member_idx ON client_ordered_owners(tenant_id,user_id);

-- Preserve even inactive historical owners; new replacements require active
-- membership. Backfill must be reviewed/qualified before authorized execution.
INSERT INTO client_ordered_owners(tenant_id,client_id,rank,user_id)
  SELECT tenant_id,id,1,account_owner_user_id FROM clients WHERE account_owner_user_id IS NOT NULL;

ALTER TABLE client_ordered_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ordered_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY client_ordered_owners_isolation ON client_ordered_owners
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON client_ordered_owners TO capiro_app;
  END IF;
END $$;

-- Deferred validation permits delete+insert+Primary replacement in one
-- transaction, while a partial/direct legacy write cannot commit divergence.
-- Invoker rights, ordinary RLS, no SECURITY DEFINER or bypass setting.
CREATE FUNCTION check_client_ordered_owners() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tenant uuid;
  target_client uuid;
  projected uuid;
  primary_owner uuid;
  owner_count integer;
  last_rank integer;
BEGIN
  IF TG_TABLE_NAME='client_ordered_owners' AND TG_OP='UPDATE' THEN
    IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.client_id IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'Owner assignment parent is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME='clients' THEN
    target_tenant := NEW.tenant_id;
    target_client := NEW.id;
  ELSIF TG_OP='DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_client := OLD.client_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_client := NEW.client_id;
  END IF;
  SELECT account_owner_user_id INTO projected FROM clients
    WHERE tenant_id=target_tenant AND id=target_client;
  IF NOT FOUND THEN RETURN NULL; END IF; -- Client deletion cascades the set.
  SELECT count(*),max(rank) INTO owner_count,last_rank FROM client_ordered_owners
    WHERE tenant_id=target_tenant AND client_id=target_client;
  SELECT user_id INTO primary_owner FROM client_ordered_owners
    WHERE tenant_id=target_tenant AND client_id=target_client AND rank=1;
  IF (owner_count>0 AND owner_count<>last_rank) OR projected IS DISTINCT FROM primary_owner THEN
    RAISE EXCEPTION 'Ordered account owners and Primary must agree' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER client_ordered_owners_consistent
  AFTER INSERT OR UPDATE OR DELETE ON client_ordered_owners
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_client_ordered_owners();
CREATE CONSTRAINT TRIGGER clients_ordered_owners_consistent
  AFTER INSERT OR UPDATE ON clients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_client_ordered_owners();
