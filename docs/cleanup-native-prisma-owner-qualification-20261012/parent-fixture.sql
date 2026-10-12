-- Synthetic final-shape parents only. Not a complete migration replay.
-- Executed only after root's isolated-target authorization; no LOGIN/password.
CREATE TABLE tenants(id uuid PRIMARY KEY,status text NOT NULL DEFAULT 'active');
CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text NOT NULL UNIQUE);
CREATE TABLE tenant_memberships(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id),role text NOT NULL,status text NOT NULL,
 UNIQUE(tenant_id,user_id));
CREATE TABLE clients(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text NOT NULL,
 status text NOT NULL DEFAULT 'active',website text,description text,sector_tag text,
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id));
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
-- Fixture-only compatibility for old default UUID expressions. This does not
-- install or qualify uuid-ossp; IDs and lock/RLS behavior use native UUID values.
CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$
 SELECT gen_random_uuid() $$;
-- Minimal legacy parent required by the exact newsletter format migration.
-- It is not an operational Outreach record/draft owner or an ID bridge.
CREATE TABLE outreach_draft_versions(id uuid PRIMARY KEY,generation_status text NOT NULL);
