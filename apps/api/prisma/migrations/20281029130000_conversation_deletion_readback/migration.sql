BEGIN;

-- Release ordering: deploy the dual-format consumed-receipt reader before
-- applying this migration. Older readers accept only the original tombstone.
-- Preserve only the identity needed to reconcile the user's original Trash
-- request. Titles, client labels, message bodies and other metadata are scrubbed.
-- Existing content-free tombstones cannot be backfilled by guessing an origin.
CREATE FUNCTION meri_management_deletion_reference_v1(p_receipt jsonb, p_conversation uuid, p_request uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN p_receipt#>>'{receipt,version}'='meri.conversation-management.v1'
    AND p_receipt#>>'{receipt,requestId}'=p_request::text
    AND p_receipt#>>'{receipt,conversation,conversationId}'=p_conversation::text
    AND p_receipt#>>'{receipt,conversation,status}'='trashed'
    AND p_receipt->'releaseRetention'='false'::jsonb
    AND p_receipt#>>'{receipt,conversation,revision}' ~ '^[1-9][0-9]{0,17}$'
    AND jsonb_typeof(p_receipt#>'{receipt,conversation,restoreUntil}')='string'
  THEN jsonb_build_object('conversationId',p_conversation::text,
    'revision',p_receipt#>>'{receipt,conversation,revision}',
    'restoreUntil',p_receipt#>>'{receipt,conversation,restoreUntil}') ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION protect_meri_management_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deletion jsonb;
BEGIN
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
    deletion := meri_management_deletion_reference_v1(OLD.receipt, OLD.conversation_id, OLD.request_id);
    -- An explicit null distinguishes a known non-deletion command from older
    -- tombstones whose original operation can no longer be established.
    NEW.receipt := jsonb_build_object('tombstone',true,'deletion',deletion);
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Management receipt is immutable' USING ERRCODE='23514';
END;
$$;

CREATE INDEX clio_management_deletion_history ON clio_conversation_management_receipts
  (tenant_id,actor_user_id,(date_trunc('milliseconds',created_at AT TIME ZONE 'UTC')) DESC,request_id DESC)
  WHERE receipt#>>'{receipt,conversation,status}'='trashed'
    OR (receipt ? 'deletion' AND receipt->'deletion'<>'null'::jsonb);
COMMIT;
