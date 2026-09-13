# Google Drive internal preview rollout

Google Workspace Developer Preview registration for project `1045442200721` was approved on 2026-09-13. Enrollment does not establish public OAuth verification or successful live authorization.

The API requires all of the following for Google Drive:

- Existing global MCP and encrypted OAuth configuration.
- `MERI_MCP_GOOGLE_DRIVE_CLIENT_ID` and `MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET` from server secret references.
- `MERI_MCP_GOOGLE_DRIVE_ENABLED=true`.
- `MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS`: comma-separated internal database user IDs.
- `MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS`: comma-separated internal database tenant IDs.

Both allowlists must match the authenticated identity. Missing lists deny access. Wildcards are not supported. IDs must come from authenticated `/api/me`, not browser-supplied connector settings, emails, or Clerk identifiers. Restrict these lists to approved internal preview participants and workspaces. OAuth test-user membership alone does not grant Meri access.

The same restriction covers app availability, connect, OAuth callback, discovery, cached schemas, and tool execution. Removing an identity prevents subsequent calls once the API configuration is rolled out. Existing encrypted credentials remain disconnectable. HubSpot, Airtable and monday.com behavior is unchanged.

For release, inspect the current ECS service and clone its exact task definition, preserving unrelated environment values and secret references. Deploy an immutable image containing this gate before enabling Drive. Mount only the dedicated Google Drive credentials; preserve the deployed callback `https://app.capiro.ai/api/clio/mcp-oauth/callback`. Record the old task ARN and image digest as the rollback point. Recheck the active task before updating the service to avoid overwriting concurrent releases. No database migration is required.

Validation on the deployed-source baseline: 10 connector/OAuth suites, 100 tests passed; API typecheck passed. Live sign-in, discovery and an actual Drive file read through Meri remain separate release evidence. The broader four-provider acceptance matrix is not completed by this restricted rollout.
