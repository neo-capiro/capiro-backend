-- Source only. Prisma's ledger is canonical; exact reruns are also safe.
-- Actual expiry/purge belongs to Meri retention, never a second Core job.
BEGIN;
DO $migration$
DECLARE item record; found_type text; expected text; actual text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('metadata_revision', 'bigint', 'bigint NOT NULL DEFAULT 0'),
    ('trashed_at', 'timestamp(3) with time zone', 'timestamptz(3)'),
    ('restore_until', 'timestamp(3) with time zone', 'timestamptz(3)')
  ) AS fields(name, type_name, definition) LOOP
    SELECT format_type(atttypid, atttypmod) INTO found_type FROM pg_attribute
      WHERE attrelid='clio_conversations'::regclass AND attname=item.name AND NOT attisdropped;
    IF NOT FOUND THEN
      EXECUTE format('ALTER TABLE clio_conversations ADD COLUMN %I %s', item.name, item.definition);
    ELSIF found_type <> item.type_name THEN RAISE EXCEPTION 'Conflicting chat metadata field %', item.name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='clio_conversations'::regclass AND a.attname='metadata_revision' AND a.attnotnull
      AND pg_get_expr(d.adbin,d.adrelid)='0') THEN RAISE EXCEPTION 'Conflicting chat revision default'; END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='clio_conversations'::regclass
    AND attname IN ('trashed_at','restore_until') AND attnotnull) THEN RAISE EXCEPTION 'Conflicting chat trash nullability'; END IF;
  CREATE TEMP TABLE meri_expected_metadata (metadata_revision bigint, status text, trashed_at timestamptz(3), restore_until timestamptz(3),
    CONSTRAINT expected_metadata CHECK (metadata_revision >= 0 AND
      ((status='trashed' AND trashed_at IS NOT NULL AND restore_until IS NOT NULL AND restore_until=trashed_at + interval '720 hours') OR
       (status<>'trashed' AND trashed_at IS NULL AND restore_until IS NULL)))) ON COMMIT DROP;
  SELECT pg_get_constraintdef(oid) INTO expected FROM pg_constraint
    WHERE conrelid='pg_temp.meri_expected_metadata'::regclass AND conname='expected_metadata';
  SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint
    WHERE conrelid='clio_conversations'::regclass AND conname='clio_conversations_management_check';
  IF actual IS NULL THEN
    ALTER TABLE clio_conversations ADD CONSTRAINT clio_conversations_management_check CHECK (metadata_revision >= 0 AND
      ((status='trashed' AND trashed_at IS NOT NULL AND restore_until IS NOT NULL AND restore_until=trashed_at + interval '720 hours') OR
       (status<>'trashed' AND trashed_at IS NULL AND restore_until IS NULL)));
  ELSIF actual<>expected THEN RAISE EXCEPTION 'Conflicting chat metadata check'; END IF;
END;
$migration$;
CREATE TABLE IF NOT EXISTS clio_conversation_management_receipts (
  tenant_id uuid NOT NULL, actor_user_id uuid NOT NULL, request_id uuid NOT NULL,
  conversation_id uuid, request_sha256 char(64) NOT NULL, receipt jsonb NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT clio_management_receipts_pkey PRIMARY KEY(tenant_id,actor_user_id,request_id),
  CONSTRAINT clio_management_receipts_tenant_fkey FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT clio_management_receipts_conversation_fkey FOREIGN KEY(conversation_id) REFERENCES clio_conversations(id) ON DELETE SET NULL
);
DO $validate$
DECLARE actual text[];
BEGIN
  SELECT array_agg(attname||':'||format_type(atttypid,atttypmod)||':'||attnotnull ORDER BY attnum) INTO actual
  FROM pg_attribute WHERE attrelid='clio_conversation_management_receipts'::regclass AND attnum>0 AND NOT attisdropped;
  IF actual IS DISTINCT FROM ARRAY['tenant_id:uuid:true','actor_user_id:uuid:true','request_id:uuid:true',
    'conversation_id:uuid:false','request_sha256:character(64):true','receipt:jsonb:true','created_at:timestamp(6) with time zone:true']
    THEN RAISE EXCEPTION 'Conflicting chat management receipt table'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='clio_conversation_management_receipts'::regclass
    AND conname='clio_management_receipts_pkey' AND pg_get_constraintdef(oid)='PRIMARY KEY (tenant_id, actor_user_id, request_id)')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='clio_conversation_management_receipts'::regclass
    AND conname='clio_management_receipts_tenant_fkey' AND contype='f' AND confrelid='tenants'::regclass AND confdeltype='c'
    AND conkey=ARRAY[1]::smallint[] AND confkey=ARRAY[1]::smallint[])
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='clio_conversation_management_receipts'::regclass
    AND conname='clio_management_receipts_conversation_fkey' AND contype='f' AND confrelid='clio_conversations'::regclass AND confdeltype='n'
    AND conkey=ARRAY[4]::smallint[] AND confkey=ARRAY[1]::smallint[])
    THEN RAISE EXCEPTION 'Conflicting chat management receipt ownership'; END IF;
END;
$validate$;
DO $guards$
DECLARE
  wanted_body text := $body$BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.conversation_id IS NULL OR NOT EXISTS (SELECT 1 FROM clio_conversations c
       WHERE c.id=NEW.conversation_id AND c.tenant_id=NEW.tenant_id AND c.user_id=NEW.actor_user_id) THEN
      RAISE EXCEPTION 'Management receipt owner mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id=OLD.tenant_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Management receipt consumed key is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM clio_conversations c WHERE c.id=OLD.conversation_id)
     AND ROW(NEW.tenant_id,NEW.actor_user_id,NEW.request_id,NEW.request_sha256,NEW.created_at)
       IS NOT DISTINCT FROM ROW(OLD.tenant_id,OLD.actor_user_id,OLD.request_id,OLD.request_sha256,OLD.created_at) THEN
    -- Canonical conversation deletion strips title/content from the receipt.
    NEW.receipt := '{"tombstone":true}'::jsonb;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Management receipt is immutable' USING ERRCODE='23514';
END;$body$;
  fn oid; existing_trigger record; policy record; expected text;
BEGIN
  fn := to_regprocedure('protect_meri_management_receipt()');
  IF fn IS NULL THEN
    EXECUTE format('CREATE FUNCTION protect_meri_management_receipt() RETURNS trigger LANGUAGE plpgsql AS %L',wanted_body);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON p.prolang=l.oid
    WHERE p.oid=fn AND p.prosrc=wanted_body AND l.lanname='plpgsql' AND NOT p.prosecdef AND p.prorettype='trigger'::regtype) THEN
    RAISE EXCEPTION 'Conflicting management receipt guard';
  END IF;
  SELECT * INTO existing_trigger FROM pg_trigger WHERE tgrelid='clio_conversation_management_receipts'::regclass
    AND tgname='clio_management_receipts_immutable';
  IF NOT FOUND THEN
    CREATE TRIGGER clio_management_receipts_immutable BEFORE INSERT OR UPDATE OR DELETE ON clio_conversation_management_receipts
      FOR EACH ROW EXECUTE FUNCTION protect_meri_management_receipt();
  ELSIF existing_trigger.tgfoid<>'protect_meri_management_receipt()'::regprocedure OR existing_trigger.tgtype<>31
      OR existing_trigger.tgenabled<>'O' OR existing_trigger.tgisinternal OR existing_trigger.tgqual IS NOT NULL
      OR existing_trigger.tgnargs<>0 OR existing_trigger.tgattr::text<>'' THEN
    RAISE EXCEPTION 'Conflicting management receipt trigger';
  END IF;
  ALTER TABLE clio_conversation_management_receipts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE clio_conversation_management_receipts FORCE ROW LEVEL SECURITY;
  CREATE TEMP TABLE meri_expected_receipt_policy(tenant_id uuid) ON COMMIT DROP;
  CREATE POLICY expected ON meri_expected_receipt_policy
    USING (rls_bypass() OR tenant_id=current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
  SELECT pg_get_expr(polqual,polrelid) INTO expected FROM pg_policy WHERE polrelid='pg_temp.meri_expected_receipt_policy'::regclass;
  SELECT * INTO policy FROM pg_policy WHERE polrelid='clio_conversation_management_receipts'::regclass
    AND polname='clio_management_receipts_isolation';
  IF NOT FOUND THEN
    CREATE POLICY clio_management_receipts_isolation ON clio_conversation_management_receipts
      USING (rls_bypass() OR tenant_id=current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
  ELSIF pg_get_expr(policy.polqual,policy.polrelid) IS DISTINCT FROM expected
      OR pg_get_expr(policy.polwithcheck,policy.polrelid) IS DISTINCT FROM expected
      OR policy.polcmd<>'*' OR NOT policy.polpermissive OR policy.polroles<>ARRAY[0]::oid[] THEN
    RAISE EXCEPTION 'Conflicting management receipt policy';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid='clio_conversation_management_receipts'::regclass)<>1 THEN
    RAISE EXCEPTION 'Unexpected management receipt policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE UPDATE,DELETE,TRUNCATE ON clio_conversation_management_receipts FROM capiro_app;
    GRANT SELECT,INSERT ON clio_conversation_management_receipts TO capiro_app;
  END IF;
END;
$guards$;
COMMIT;
