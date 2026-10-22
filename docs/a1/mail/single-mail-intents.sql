-- PROPOSAL ONLY: Fable owns migration numbering and snapshot/deployment order.
-- Apply before the A1 single-mail code reaches an ordinary staging deployment.
CREATE TABLE single_mail_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Actor/client/mailbox identity survives individual removal. Current access
  -- is always checked by the service. Authorized tenant destruction purges all.
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
CREATE INDEX single_mail_intents_actor_recent ON single_mail_intents (tenant_id, actor_id, created_at DESC);
ALTER TABLE single_mail_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE single_mail_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY single_mail_intents_tenant ON single_mail_intents
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
-- No scheduler resets sending/unknown/pending. These identities are never recycled.
