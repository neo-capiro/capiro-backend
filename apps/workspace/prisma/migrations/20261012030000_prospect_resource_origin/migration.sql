-- SOURCE ONLY; deliberately not executed. Workspace owns ws_* tables only.
-- Core prospect identity is verified in tenant-scoped application transactions;
-- preserve the existing no-cross-Core-FK boundary. A missing origin fails closed.
ALTER TABLE ws_draft ADD COLUMN prospect_id uuid;
CREATE INDEX ws_draft_prospect_idx ON ws_draft(tenant_id,prospect_id,updated_at);
CREATE TABLE ws_prospect_draft_receipt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 owner_id text NOT NULL,
 request_id uuid NOT NULL,
 prospect_id uuid NOT NULL,
 input_hash varchar(64) NOT NULL,
 draft_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT ws_prospect_draft_receipt_request_key UNIQUE(tenant_id,owner_id,request_id)
);
CREATE INDEX ws_prospect_draft_receipt_prospect_idx ON ws_prospect_draft_receipt(tenant_id,prospect_id);
ALTER TABLE ws_prospect_draft_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE ws_prospect_draft_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_prospect_draft_receipt_isolation ON ws_prospect_draft_receipt
 USING(tenant_id=NULLIF(current_setting('app.current_tenant',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.current_tenant',true),'')::uuid);
CREATE FUNCTION ws_preserve_prospect_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.prospect_id IS DISTINCT FROM OLD.prospect_id OR
   (OLD.prospect_id IS NOT NULL AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id)) THEN
   RAISE EXCEPTION 'workspace prospect origin is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ws_draft_preserve_prospect_origin BEFORE UPDATE ON ws_draft
 FOR EACH ROW EXECUTE FUNCTION ws_preserve_prospect_origin();
CREATE FUNCTION ws_preserve_prospect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'workspace prospect receipt is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER ws_prospect_draft_receipt_immutable BEFORE UPDATE ON ws_prospect_draft_receipt
 FOR EACH ROW EXECUTE FUNCTION ws_preserve_prospect_receipt();
-- No data copy/backfill, free-text matching, public token grant or new Core FK.
