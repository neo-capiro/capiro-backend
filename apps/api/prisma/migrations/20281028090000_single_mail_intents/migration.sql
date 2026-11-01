-- A1 single-mail ledger. The code that writes this table (apps/api/src/engagement/single-mail-ledger.ts)
-- shipped before any migration created it, so every Microsoft Graph mail sync fails on
-- `relation "single_mail_intents" does not exist` (42P01) while calendar sync succeeds. The DDL
-- existed only as a proposal in docs/a1/mail/single-mail-intents.sql, whose header requires it to
-- be applied before the A1 code reaches a deployment.
--
-- Guards keep this idempotent for databases where the proposal was applied by hand: the table, its
-- index and its policy are created only when absent, so `migrate deploy` neither fails nor
-- duplicates. No existing row, table or role grant is touched.
BEGIN;

CREATE TABLE IF NOT EXISTS single_mail_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Actor/client/mailbox identity survives individual removal. Current access is always checked by
  -- the service. Authorized tenant destruction purges all.
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- Immutable mailbox lineage survives disconnection/deletion; never cascade the send fence.
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

CREATE INDEX IF NOT EXISTS single_mail_intents_actor_recent
  ON single_mail_intents (tenant_id, actor_id, created_at DESC);

ALTER TABLE single_mail_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE single_mail_intents FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'single_mail_intents'
      AND policyname = 'single_mail_intents_tenant'
  ) THEN
    CREATE POLICY single_mail_intents_tenant ON single_mail_intents
      USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
  END IF;
END $$;

COMMIT;
