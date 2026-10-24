-- Synthetic queried-column subset of identity/Engagement core and mail removal migrations.
-- Applied only after fixture.ts validates an empty local PG16 database and minimal test role.
CREATE TYPE tenant_status AS ENUM ('active','suspended','pending');
ALTER TABLE tenants ADD COLUMN status tenant_status NOT NULL DEFAULT 'active';
ALTER TABLE clients ADD COLUMN name text NOT NULL DEFAULT 'Synthetic client',
  ADD COLUMN website text, ADD COLUMN primary_contact_name text,
  ADD COLUMN primary_contact_email text, ADD COLUMN intake_data_jsonb jsonb NOT NULL DEFAULT '{}';
CREATE TYPE engagement_provider AS ENUM ('microsoft_365','google_workspace','imap_caldav','manual');
CREATE TYPE engagement_connection_status AS ENUM ('needs_configuration','connected','error','disabled');
CREATE TABLE client_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
  client_id uuid NOT NULL REFERENCES clients(id),email text
);
CREATE TABLE engagement_connections (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),provider engagement_provider NOT NULL,
  account_email text,status engagement_connection_status NOT NULL DEFAULT 'connected',
  created_by_user_id uuid REFERENCES users(id),last_sync_at timestamptz(6),sync_state_jsonb jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz(6) NOT NULL DEFAULT now(),updated_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE TABLE mail_threads (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid REFERENCES clients(id),
  connection_id uuid REFERENCES engagement_connections(id) ON DELETE SET NULL,subject text NOT NULL,
  snippet text,participants_jsonb jsonb NOT NULL DEFAULT '[]',last_message_at timestamptz(6),
  created_at timestamptz(6) NOT NULL,updated_at timestamptz(6) NOT NULL
);
CREATE TABLE mail_messages (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),thread_id uuid NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES engagement_connections(id) ON DELETE SET NULL,subject text,from_email text,from_name text,
  to_recipients_jsonb jsonb NOT NULL DEFAULT '[]',cc_recipients_jsonb jsonb NOT NULL DEFAULT '[]',
  bcc_recipients_jsonb jsonb NOT NULL DEFAULT '[]',body_text text,has_attachments boolean NOT NULL DEFAULT false,
  sent_at timestamptz(6),received_at timestamptz(6),created_at timestamptz(6) NOT NULL,updated_at timestamptz(6) NOT NULL,
  removed_at timestamptz(6),metadata_jsonb jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX mail_messages_thread_removed_received_idx ON mail_messages(thread_id,removed_at,received_at);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['client_people','engagement_connections','mail_threads','mail_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id())',t);
    EXECUTE format('GRANT SELECT ON %I TO capiro_app',t);
  END LOOP;
END $$;
