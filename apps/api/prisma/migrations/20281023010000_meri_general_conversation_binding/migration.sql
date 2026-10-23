-- Source-only. The Prisma ledger applies this once; the guarded transaction
-- also permits an exact rerun and refuses conflicting pre-existing definitions.
-- Legacy null-client prospect/research rows are never backfilled as General.
BEGIN;
-- The historical receipt guard remains installed. Its client equality must be
-- null-safe for General FK tombstones; a second trigger cannot override it.
-- Upgrade only the exact known predecessor (or accept this exact repaired body).
DO $baseline_guard$
DECLARE
  old_body text := $old$
BEGIN
  IF OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NULL
     AND NEW.tenant_id=OLD.tenant_id
     AND NEW.actor_user_id=OLD.actor_user_id
     AND NEW.request_id=OLD.request_id
     AND NEW.client_id=OLD.client_id
     AND NEW.created_at=OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Clio bootstrap receipt is immutable' USING ERRCODE='23514';
END $old$;
  new_body text;
  guard oid := to_regprocedure('clio_bootstrap_receipt_update_guard()');
  definition record;
  installed_trigger record;
BEGIN
  old_body := replace(old_body,E'\r\n',E'\n');
  new_body := replace(replace(old_body,
    'AND NEW.client_id=OLD.client_id',
    'AND NEW.client_id IS NOT DISTINCT FROM OLD.client_id'),
    'AND NEW.conversation_id IS NULL',
    'AND NEW.conversation_id IS NULL AND pg_trigger_depth()>1 AND NOT EXISTS (SELECT 1 FROM clio_conversations c WHERE c.id=OLD.conversation_id)');
  SELECT p.*,l.lanname INTO definition FROM pg_proc p JOIN pg_language l ON p.prolang=l.oid WHERE p.oid=guard;
  IF NOT FOUND OR definition.lanname<>'plpgsql' OR definition.prosecdef OR definition.proisstrict
     OR definition.proleakproof OR definition.prokind<>'f' OR definition.provolatile<>'v' OR definition.proparallel<>'u'
     OR definition.proconfig IS NOT NULL OR definition.prorettype<>'trigger'::regtype
     OR replace(definition.prosrc,E'\r\n',E'\n') NOT IN (old_body,new_body) THEN
    RAISE EXCEPTION 'Conflicting or missing historical Meri receipt guard';
  END IF;
  SELECT * INTO installed_trigger FROM pg_trigger
    WHERE tgrelid='clio_conversation_bootstrap_receipts'::regclass AND tgname='clio_bootstrap_receipt_immutable';
  IF NOT FOUND OR installed_trigger.tgfoid<>guard OR installed_trigger.tgtype<>19 OR installed_trigger.tgenabled<>'O'
     OR installed_trigger.tgisinternal OR installed_trigger.tgqual IS NOT NULL OR installed_trigger.tgnargs<>0
     OR installed_trigger.tgattr::text<>'' OR installed_trigger.tgconstraint<>0 THEN
    RAISE EXCEPTION 'Conflicting or disabled historical Meri receipt trigger';
  END IF;
  IF replace(definition.prosrc,E'\r\n',E'\n')=old_body THEN
    EXECUTE format('CREATE OR REPLACE FUNCTION clio_bootstrap_receipt_update_guard() RETURNS trigger LANGUAGE plpgsql AS %L',new_body);
  END IF;
END;
$baseline_guard$;
DO $migration$
DECLARE
  wanted_body text := $function$BEGIN
  IF TG_TABLE_NAME = 'clio_conversation_bootstrap_receipts' THEN
    IF ROW(NEW.tenant_id, NEW.actor_user_id, NEW.request_id, NEW.scope_kind, NEW.client_id)
       IS DISTINCT FROM
       ROW(OLD.tenant_id, OLD.actor_user_id, OLD.request_id, OLD.scope_kind, OLD.client_id)
       OR (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND
           NOT (OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NULL AND
                NOT EXISTS (SELECT 1 FROM clio_conversations c WHERE c.id = OLD.conversation_id))) THEN
      RAISE EXCEPTION 'Meri bootstrap binding is immutable' USING ERRCODE = '23514';
    END IF;
    -- ON DELETE SET NULL intentionally preserves the consumed request tombstone.
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM clio_conversation_bootstrap_receipts r
             WHERE r.conversation_id = OLD.id) THEN
    IF ROW(NEW.tenant_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.tenant_id, OLD.user_id)
       OR (NEW.client_id IS DISTINCT FROM OLD.client_id AND NOT (
         OLD.client_id IS NOT NULL AND NEW.client_id IS NULL AND
         NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = OLD.client_id)
       )) THEN
      RAISE EXCEPTION 'Meri conversation scope is immutable' USING ERRCODE = '23514';
    END IF;
    -- A client's FK SET NULL is allowed only after that client was deleted.
    -- The immutable receipt still remembers its client, so authority fails
    -- closed; this orphan never becomes General and cannot be rebound.
  END IF;
  RETURN NEW;
END;$function$;
  existing_function oid;
  actual_constraint text;
  expected_constraint text;
  receipt_table regclass := 'clio_conversation_bootstrap_receipts'::regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = receipt_table
                 AND attname = 'scope_kind' AND NOT attisdropped) THEN
    ALTER TABLE clio_conversation_bootstrap_receipts ADD COLUMN scope_kind text NOT NULL DEFAULT 'client';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = receipt_table AND a.attname = 'scope_kind' AND NOT a.attisdropped
      AND a.atttypid = 'text'::regtype AND a.attnotnull
      AND pg_get_expr(d.adbin, d.adrelid) = '''client''::text'
  ) THEN
    RAISE EXCEPTION 'Conflicting Meri scope_kind definition';
  END IF;
  ALTER TABLE clio_conversation_bootstrap_receipts ALTER COLUMN client_id DROP NOT NULL;
  -- PostgreSQL itself renders both checks, avoiding a guessed deparse.
  CREATE TEMP TABLE meri_expected_binding (scope_kind text, client_id uuid,
    CONSTRAINT expected_binding CHECK (
      (scope_kind = 'client' AND client_id IS NOT NULL) OR
      (scope_kind = 'general' AND client_id IS NULL)
    )) ON COMMIT DROP;
  SELECT pg_get_constraintdef(oid) INTO expected_constraint FROM pg_constraint
    WHERE conrelid = 'pg_temp.meri_expected_binding'::regclass AND conname = 'expected_binding';
  SELECT pg_get_constraintdef(oid) INTO actual_constraint FROM pg_constraint
    WHERE conrelid = receipt_table AND conname = 'clio_bootstrap_receipts_scope_check';
  IF actual_constraint IS NULL THEN
    ALTER TABLE clio_conversation_bootstrap_receipts ADD CONSTRAINT clio_bootstrap_receipts_scope_check CHECK (
      (scope_kind = 'client' AND client_id IS NOT NULL) OR
      (scope_kind = 'general' AND client_id IS NULL)
    );
  ELSIF actual_constraint <> expected_constraint THEN
    RAISE EXCEPTION 'Conflicting Meri scope check';
  END IF;
  existing_function := to_regprocedure('protect_meri_bootstrap_binding()');
  IF existing_function IS NULL THEN
    EXECUTE format('CREATE FUNCTION protect_meri_bootstrap_binding() RETURNS trigger LANGUAGE plpgsql AS %L', wanted_body);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON p.prolang = l.oid
                   WHERE p.oid = existing_function AND p.prosrc = wanted_body
                     AND l.lanname = 'plpgsql' AND NOT p.prosecdef AND p.prorettype = 'trigger'::regtype) THEN
    RAISE EXCEPTION 'Conflicting Meri binding function';
  END IF;
END;
$migration$;

DO $triggers$
DECLARE
  item record;
  existing_trigger record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('clio_conversation_bootstrap_receipts', 'clio_bootstrap_receipts_immutable_binding'),
    ('clio_conversations', 'clio_conversations_immutable_bootstrap_binding')
  ) AS wanted(table_name, trigger_name) LOOP
    SELECT * INTO existing_trigger FROM pg_trigger
      WHERE tgrelid = item.table_name::regclass AND tgname = item.trigger_name;
    IF NOT FOUND THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION protect_meri_bootstrap_binding()',
                     item.trigger_name, item.table_name);
    ELSIF existing_trigger.tgfoid <> 'protect_meri_bootstrap_binding()'::regprocedure
       OR existing_trigger.tgtype <> 19 OR existing_trigger.tgenabled <> 'O'
       OR existing_trigger.tgisinternal OR existing_trigger.tgqual IS NOT NULL
       OR existing_trigger.tgnargs <> 0 OR existing_trigger.tgattr::text <> '' THEN
      RAISE EXCEPTION 'Conflicting Meri binding trigger %', item.trigger_name;
    END IF;
  END LOOP;
END;
$triggers$;
COMMIT;
