-- RESERVED source only; not a Prisma deploy directory. Requires the unchanged
-- 20281018060000 reserved family and 20281023010000 explicit bootstrap binding.
-- Existing v1 rows remain client-scoped. No grants, modes, TTLs or ceilings widen.
BEGIN;
DO $migration$
DECLARE
  actual text;
  expected text;
  item record;
  wanted_body text := $body$BEGIN
  IF TG_TABLE_NAME = 'meri_read_delegations' THEN
    IF TG_OP = 'UPDATE' AND ROW(NEW.scope_kind, NEW.client_id, NEW.tenant_id, NEW.user_id, NEW.conversation_id, NEW.run_id)
      IS DISTINCT FROM ROW(OLD.scope_kind, OLD.client_id, OLD.tenant_id, OLD.user_id, OLD.conversation_id, OLD.run_id) THEN
      RAISE EXCEPTION 'Read delegation origin is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.scope_kind = 'general' AND NOT EXISTS (
      SELECT 1 FROM clio_conversations c JOIN clio_conversation_bootstrap_receipts b ON b.conversation_id = c.id
      WHERE c.id = NEW.conversation_id AND c.tenant_id = NEW.tenant_id AND c.user_id = NEW.user_id
        AND c.client_id IS NULL AND c.status = 'active' AND c.archived_at IS NULL
        AND b.tenant_id = NEW.tenant_id AND b.actor_user_id = NEW.user_id
        AND b.scope_kind = 'general' AND b.client_id IS NULL
    ) THEN
      RAISE EXCEPTION 'Explicit General origin required' USING ERRCODE = '23514';
    END IF;
  ELSIF ROW(NEW.run_id, NEW.call_key, NEW.tenant_id, NEW.target_client_id)
    IS DISTINCT FROM ROW(OLD.run_id, OLD.call_key, OLD.tenant_id, OLD.target_client_id) THEN
    RAISE EXCEPTION 'Read call target is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;$body$;
  fn oid;
BEGIN
  IF to_regclass('meri_read_delegations') IS NULL OR to_regclass('meri_read_delegation_slots') IS NULL OR
     to_regclass('clio_conversation_bootstrap_receipts') IS NULL THEN
    RAISE EXCEPTION 'Reserved read delegation and explicit bootstrap predecessors are required';
  END IF;
  -- Verify the security-critical predecessor shape before relaxing nullability.
  FOR item IN SELECT * FROM (VALUES
    ('meri_read_delegations','client_id','uuid'::regtype),
    ('meri_read_delegations','tenant_id','uuid'::regtype),
    ('meri_read_delegations','user_id','uuid'::regtype),
    ('meri_read_delegations','conversation_id','uuid'::regtype),
    ('meri_read_delegation_slots','run_id','uuid'::regtype),
    ('clio_conversation_bootstrap_receipts','scope_kind','text'::regtype)
  ) AS required(table_name,column_name,type_id) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=item.table_name::regclass
      AND attname=item.column_name AND atttypid=item.type_id AND NOT attisdropped) THEN
      RAISE EXCEPTION 'Conflicting predecessor column %.%', item.table_name,item.column_name;
    END IF;
  END LOOP;
  CREATE TEMP TABLE expected_read_general (scope_kind text, client_id uuid, mode text,
    CONSTRAINT expected_scope CHECK ((scope_kind='client' AND client_id IS NOT NULL) OR
      (scope_kind='general' AND client_id IS NULL AND mode='attended')),
    CONSTRAINT expected_mode CHECK (mode IN ('attended','unattended'))) ON COMMIT DROP;
  SELECT pg_get_constraintdef(oid) INTO expected FROM pg_constraint WHERE conrelid='pg_temp.expected_read_general'::regclass AND conname='expected_mode';
  SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint WHERE conrelid='meri_read_delegations'::regclass AND conname='meri_read_delegations_mode_check';
  IF actual IS DISTINCT FROM expected OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='meri_read_delegations'::regclass
    AND conname='meri_read_delegations_mode_check' AND contype='c' AND convalidated) THEN RAISE EXCEPTION 'Conflicting predecessor mode constraint'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='meri_read_delegations'::regclass AND attname='scope_kind' AND NOT attisdropped) THEN
    ALTER TABLE meri_read_delegations ADD COLUMN scope_kind text NOT NULL DEFAULT 'client';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='meri_read_delegations'::regclass AND a.attname='scope_kind' AND a.atttypid='text'::regtype
      AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='''client''::text') THEN
    RAISE EXCEPTION 'Conflicting read delegation scope column';
  END IF;
  ALTER TABLE meri_read_delegations ALTER COLUMN client_id DROP NOT NULL;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='meri_read_delegation_slots'::regclass AND attname='target_client_id' AND NOT attisdropped) THEN
    ALTER TABLE meri_read_delegation_slots ADD COLUMN target_client_id uuid;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid='meri_read_delegation_slots'::regclass
    AND a.attname='target_client_id' AND a.atttypid='uuid'::regtype AND NOT a.attnotnull AND NOT a.atthasdef) THEN
    RAISE EXCEPTION 'Conflicting read target column';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO expected FROM pg_constraint WHERE conrelid='pg_temp.expected_read_general'::regclass AND conname='expected_scope';
  SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint WHERE conrelid='meri_read_delegations'::regclass AND conname='meri_read_delegations_scope_check';
  IF actual IS NULL THEN
    ALTER TABLE meri_read_delegations ADD CONSTRAINT meri_read_delegations_scope_check CHECK (
      (scope_kind='client' AND client_id IS NOT NULL) OR (scope_kind='general' AND client_id IS NULL AND mode='attended'));
  ELSIF actual <> expected OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='meri_read_delegations'::regclass
    AND conname='meri_read_delegations_scope_check' AND contype='c' AND convalidated) THEN RAISE EXCEPTION 'Conflicting read scope constraint'; END IF;
  fn := to_regprocedure('protect_meri_read_general_binding()');
  IF fn IS NULL THEN
    EXECUTE format('CREATE FUNCTION protect_meri_read_general_binding() RETURNS trigger LANGUAGE plpgsql AS %L',wanted_body);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=fn
    AND p.prosrc=wanted_body AND l.lanname='plpgsql' AND NOT p.prosecdef AND p.prorettype='trigger'::regtype
    AND NOT p.proisstrict AND NOT p.proleakproof AND p.prokind='f' AND p.provolatile='v'
    AND p.proparallel='u' AND p.proconfig IS NULL) THEN
    RAISE EXCEPTION 'Conflicting read binding trigger function';
  END IF;
END;
$migration$;
DO $triggers$
DECLARE item record; found_trigger record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('meri_read_delegations','meri_read_delegations_general_binding',23,'INSERT OR UPDATE'),
    ('meri_read_delegation_slots','meri_read_slots_target_binding',19,'UPDATE')) AS wanted(table_name,trigger_name,trigger_type,events) LOOP
    SELECT * INTO found_trigger FROM pg_trigger WHERE tgrelid=item.table_name::regclass AND tgname=item.trigger_name;
    IF NOT FOUND THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE %s ON %I FOR EACH ROW EXECUTE FUNCTION protect_meri_read_general_binding()',item.trigger_name,item.events,item.table_name);
    ELSIF found_trigger.tgfoid <> 'protect_meri_read_general_binding()'::regprocedure OR found_trigger.tgtype <> item.trigger_type
      OR found_trigger.tgenabled <> 'O' OR found_trigger.tgisinternal OR found_trigger.tgqual IS NOT NULL OR found_trigger.tgconstraint <> 0
      OR found_trigger.tgnargs <> 0 OR found_trigger.tgattr::text <> '' THEN
      RAISE EXCEPTION 'Conflicting read binding trigger %',item.trigger_name;
    END IF;
  END LOOP;
END;
$triggers$;
COMMIT;
