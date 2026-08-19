-- Client account teams.
--
-- Capiro has always had a SINGLE `clients.account_owner_user_id` and nothing
-- else, so the client profile's "Account team" slot had no backing record: the
-- vNext overview model hardcoded `accountTeam: []` / `accountTeamAvailable:
-- false` and the card rendered "No roster" with a link to firm-wide team
-- settings. There was no way to put anyone on an account team because there was
-- nowhere to put them.
--
-- This is that table: which of the firm's own users work an account, with an
-- optional free-text role. Deliberately NOT a controlled role vocabulary —
-- there is no product decision behind one, and an invented enum would be
-- fabricated structure. The account OWNER stays where it is
-- (`clients.account_owner_user_id`); a row here is additional team membership,
-- and the two are read together by the API rather than duplicated in storage.
--
-- ADDITIVE AND INERT ON APPLY: a new empty table plus the standard tenant-
-- isolation RLS policy. No existing row, column, policy, or index changes, so
-- applying this is a provable no-op for all current data and every existing
-- read path keeps behaving exactly as it does today.

CREATE TABLE "client_team_members" (
  "id"         UUID           NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"  UUID           NOT NULL,
  "client_id"  UUID           NOT NULL,
  "user_id"    UUID           NOT NULL,
  -- Free text, e.g. "Lead lobbyist", "Research". NULL = on the team, no
  -- stated role — which is a real and common answer, not missing data.
  "role"       TEXT,
  -- Plain uuid, no FK: mirrors clients.created_by_user_id so the record
  -- survives the assigner leaving the firm.
  "added_by"   UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "client_team_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_team_members_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "client_team_members_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE,
  -- A departed user's membership disappears with them rather than dangling as
  -- an unresolvable id on the roster.
  CONSTRAINT "client_team_members_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- One membership per person per client; re-adding updates the role instead of
-- creating a duplicate roster entry (the service upserts on this constraint).
CREATE UNIQUE INDEX "client_team_members_uniq"
  ON "client_team_members" ("tenant_id", "client_id", "user_id");

-- The roster read: every member of one client.
CREATE INDEX "client_team_members_client_idx"
  ON "client_team_members" ("tenant_id", "client_id");

-- The reverse read: every account one user works.
CREATE INDEX "client_team_members_user_idx"
  ON "client_team_members" ("tenant_id", "user_id");

-- RLS: tenant isolation, the standard pattern (20260501000000).
ALTER TABLE "client_team_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_team_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY "client_team_members_isolation" ON "client_team_members"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "client_team_members" TO capiro_app;
  END IF;
END
$$;
