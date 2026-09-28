BEGIN;

-- Duplicate deletion is an explicitly reviewed maintenance operation. A normal
-- migration may only prove the existing global uniqueness invariant. An absent
-- or invalid invariant fails closed; tenant-filtered empty reads are not proof.
LOCK TABLE public.client_intel_mapping IN SHARE MODE;

DO $invariant$
DECLARE
  target oid := 'public.client_intel_mapping'::regclass;
  key_columns smallint[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=target AND relkind='r')
     OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=target OR inhparent=target) THEN
    RAISE EXCEPTION 'Dedup requires a reviewed unpartitioned, non-inherited mapping table';
  END IF;
  SELECT array_agg(attnum ORDER BY attnum) INTO key_columns
  FROM pg_attribute
  WHERE attrelid=target AND attname IN ('client_id','source','external_id')
    AND attnum>0 AND NOT attisdropped AND attnotnull;
  IF cardinality(key_columns) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Dedup key columns must exist and be non-null';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class ic ON ic.oid=i.indexrelid
    JOIN pg_am am ON am.oid=ic.relam
    WHERE i.indrelid=target AND i.indisunique AND i.indisvalid
      AND i.indisready AND i.indislive AND i.indimmediate
      AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=3
      AND am.amname='btree'
      AND (SELECT array_agg(k.attnum ORDER BY k.attnum)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord)
           WHERE k.ord<=i.indnkeyatts)=key_columns
      AND NOT EXISTS (
        SELECT 1 FROM unnest(i.indclass) WITH ORDINALITY AS k(opclass,ord)
        JOIN pg_opclass oc ON oc.oid=k.opclass
        JOIN pg_namespace ns ON ns.oid=oc.opcnamespace
        WHERE k.ord<=i.indnkeyatts
          AND (ns.nspname<>'pg_catalog' OR oc.opcname NOT IN ('uuid_ops','text_ops'))
      )
  ) THEN
    RAISE EXCEPTION 'Global dedup uniqueness is unproven; stop for approved tenant inventory, exact denominator, durable backup and audited repair';
  END IF;
END;
$invariant$;

COMMIT;
