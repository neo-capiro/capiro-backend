-- A1 single-mail ledger. The code that writes this table (apps/api/src/engagement/single-mail-ledger.ts)
-- shipped before any migration created it, so every Microsoft Graph mail sync fails on
-- `relation "single_mail_intents" does not exist` (42P01) while calendar sync succeeds. The DDL
-- existed only as a proposal in docs/a1/mail/single-mail-intents.sql, whose header requires it to
-- be applied before the A1 code reaches a deployment.
--
-- Accept a fresh table or the exact compatible manual proposal. Existing objects are inspected,
-- never repaired by name: missing keys or broader policies must abort the entire migration.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;

DO $create$
BEGIN
  IF to_regclass('public.single_mail_intents') IS NULL THEN
    CREATE TABLE public.single_mail_intents (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
      actor_id uuid NOT NULL,
      request_key uuid NOT NULL,
      request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      connection_id uuid NOT NULL,
      client_id uuid,
      state text NOT NULL CHECK (state IN ('pending','sending','accepted','unknown','failed')),
      snapshot jsonb NOT NULL,
      provider_evidence jsonb,
      receipt jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, actor_id, request_key)
    );
    CREATE INDEX single_mail_intents_actor_recent
      ON public.single_mail_intents (tenant_id, actor_id, created_at DESC);
    ALTER TABLE public.single_mail_intents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.single_mail_intents FORCE ROW LEVEL SECURITY;
    CREATE POLICY single_mail_intents_tenant ON public.single_mail_intents
      USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
  END IF;
END $create$;

-- Let this server parse the expected expressions, types, indexes and policy, so comparison does
-- not depend on hard-coded deparser formatting. This empty temporary reference is transaction
-- local; TEMP privilege is required. A name collision fails rather than trusting a prior object.
-- Temporary tables cannot reference permanent tables, so validate the tenant FK separately.
CREATE TEMP TABLE pg_temp._single_mail_intents_contract (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  connection_id uuid NOT NULL,
  client_id uuid,
  state text NOT NULL CHECK (state IN ('pending','sending','accepted','unknown','failed')),
  snapshot jsonb NOT NULL,
  provider_evidence jsonb,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, actor_id, request_key)
) ON COMMIT DROP;

CREATE INDEX single_mail_intents_actor_recent
  ON pg_temp._single_mail_intents_contract (tenant_id, actor_id, created_at DESC);
CREATE POLICY single_mail_intents_tenant ON pg_temp._single_mail_intents_contract
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);

DO $validate$
DECLARE
  target oid := 'public.single_mail_intents'::regclass;
  reference oid := 'pg_temp._single_mail_intents_contract'::regclass;
  contract record;
  actual jsonb;
  expected jsonb;
  section text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = target AND relkind = 'r' AND relpersistence = 'p' AND NOT relispartition
  ) THEN
    RAISE EXCEPTION 'single_mail_intents compatibility: expected an ordinary permanent public table';
  END IF;

  -- Hold the inspected definition stable until COMMIT, including its policy set.
  LOCK TABLE public.single_mail_intents IN ACCESS EXCLUSIVE MODE;
  IF target <> 'public.single_mail_intents'::regclass THEN
    RAISE EXCEPTION 'single_mail_intents compatibility: relation changed while acquiring lock';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class t JOIN pg_class r ON r.oid = reference
    WHERE t.oid = target AND t.relrowsecurity AND t.relforcerowsecurity
      AND t.relkind = 'r' AND t.relpersistence = 'p' AND NOT t.relispartition
      AND t.relam = r.relam
  ) OR EXISTS (
    SELECT 1 FROM pg_inherits WHERE inhrelid = target OR inhparent = target
  ) OR EXISTS (
    SELECT 1 FROM pg_rewrite WHERE ev_class = target
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = target AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'single_mail_intents compatibility: RLS, storage, inheritance, rule or trigger mismatch';
  END IF;

  -- Compare complete multisets, not names or a subset of matching definitions. Constraint names
  -- may differ; their keys, validation, timing and expressions must not. Index names may differ
  -- for constraint indexes, but actor_recent must identify the intended usable btree index.
  FOR contract IN
    SELECT relation.oid, jsonb_build_object(
      'columns', (
        SELECT jsonb_agg(definition ORDER BY definition)
        FROM (
          SELECT jsonb_build_array(
            a.attnum, a.attname, a.atttypid, a.atttypmod, a.attcollation, a.attnotnull,
            a.attisdropped, a.attidentity, a.attgenerated, a.attislocal, a.attinhcount,
            pg_get_expr(d.adbin, d.adrelid, false)
          ) AS definition
          FROM pg_attribute a LEFT JOIN pg_attrdef d
            ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = relation.oid AND a.attnum > 0
        ) definitions
      ),
      'constraints', (
        SELECT jsonb_agg(definition ORDER BY definition)
        FROM (
          SELECT jsonb_build_array(
            c.contype, c.conkey, c.condeferrable, c.condeferred, c.convalidated,
            c.connoinherit, c.conislocal, c.coninhcount, c.conparentid,
            pg_get_expr(c.conbin, c.conrelid, false)
          ) AS definition
          FROM pg_constraint c WHERE c.conrelid = relation.oid AND c.contype <> 'f'
        ) definitions
      ),
      'indexes', (
        SELECT jsonb_agg(definition ORDER BY definition)
        FROM (
          SELECT jsonb_build_array(
            ic.relname = 'single_mail_intents_actor_recent', ic.relkind, am.amname,
            i.indnatts, i.indnkeyatts, i.indisunique, i.indisprimary, i.indisexclusion,
            i.indimmediate, i.indisvalid, i.indisready, i.indislive,
            i.indkey::text, i.indcollation::text, i.indclass::text, i.indoption::text,
            pg_get_expr(i.indexprs, i.indrelid, false), pg_get_expr(i.indpred, i.indrelid, false)
          ) AS definition
          FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
          JOIN pg_am am ON am.oid = ic.relam
          WHERE i.indrelid = relation.oid
        ) definitions
      ),
      'policies', (
        SELECT jsonb_agg(definition ORDER BY definition)
        FROM (
          SELECT jsonb_build_array(
            p.polname, p.polcmd, p.polpermissive, p.polroles,
            pg_get_expr(p.polqual, p.polrelid, false),
            pg_get_expr(p.polwithcheck, p.polrelid, false)
          ) AS definition
          FROM pg_policy p WHERE p.polrelid = relation.oid
        ) definitions
      )
    ) AS definition
    FROM (VALUES (target), (reference)) AS relation(oid)
  LOOP
    IF contract.oid = target THEN actual := contract.definition;
    ELSE expected := contract.definition;
    END IF;
  END LOOP;

  FOREACH section IN ARRAY ARRAY['columns', 'constraints', 'indexes', 'policies']
  LOOP
    IF actual -> section IS DISTINCT FROM expected -> section THEN
      RAISE EXCEPTION 'single_mail_intents compatibility: % differ from the supported proposal', section
        USING HINT = 'Stop and reconcile the existing definition with its owner; this migration does not repair existing objects.';
    END IF;
  END LOOP;

  -- The sole FK must preserve ledger identities on actor/mailbox removal and cascade only on
  -- tenant deletion. Check the referenced relation/column, actions, timing and enforcement.
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = target AND contype = 'f') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = 'public.tenants'::regclass AND a.attname = 'id'
        AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.conrelid = target AND c.contype = 'f'
        AND c.conkey = ARRAY[2]::smallint[]
        AND c.confrelid = 'public.tenants'::regclass AND c.confkey = ARRAY[a.attnum]
        AND c.confdeltype = 'c' AND c.confupdtype = 'a' AND c.confmatchtype = 's'
        AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
        AND c.conislocal AND c.coninhcount = 0 AND c.conparentid = 0
    ) OR EXISTS (
      SELECT 1 FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
      WHERE c.conrelid = target AND c.contype = 'f' AND t.tgenabled <> 'O'
    ) THEN
    RAISE EXCEPTION 'single_mail_intents compatibility: tenant foreign key differs from the supported proposal';
  END IF;
END $validate$;

COMMIT;
