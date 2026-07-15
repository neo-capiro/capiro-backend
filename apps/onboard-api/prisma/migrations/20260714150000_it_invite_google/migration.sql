-- Google IT-admin verification: record the customer's Workspace primary domain
-- (id_token `hd` claim) when the org admin completes the test-connect grant —
-- the Google analog of entra_tenant_id.
ALTER TABLE "onboard_it_invite" ADD COLUMN "google_workspace_domain" TEXT;
