# Meri four-connector release acceptance

Status on 2026-09-12: **FAIL / NOT READY TO RELEASE**. Code is in draft PR #1611.
No production deployment or provider authorization has been performed.

## Current evidence

- Implementation commit: 72e1aacfaa05e0aa3324c979c9ce6a6be7725fed (subsequent hardening is in the same PR).
- GitHub Actions run [34690290244](https://github.com/neo-capiro/capirov2/actions/runs/34690290244) failed before any job steps ran. The verification, formatting and deployed-configuration jobs all had zero steps and no downloadable logs. The cause is not established through the available API.
- Local commands also failed before shell launch: Windows sandbox helper OS error 206.
- Tests were added but have **not run**. No typecheck, build, formatter or live deployment inspection has passed.
- The running API's callback, credential references, secret-loading permissions and provider flags are therefore **unverified**. Missing values in source are not evidence of missing deployed values.
- No fixture account or completed public integration/preview approval was verified.

| Provider | Acceptance result | Live sign-in | Authenticated fixture read |
| --- | --- | --- | --- |
| HubSpot | FAIL: acceptance incomplete | Not run | Not run |
| Airtable | FAIL: acceptance incomplete | Not run | Not run |
| monday.com | FAIL: acceptance incomplete | Not run | Not run |
| Google Drive | FAIL: acceptance incomplete | Not run | Not run |

Do not interpret an unauthenticated HTTP response or successful tools/list alone as a successful fixture read.

## Provider configuration owned by Capiro

All endpoints, client credentials and OAuth scopes are resolved by the API. Browser connect/cancel/disconnect requests contain only the selected app ID. One personal connection per provider uses existing encrypted credential tables; no migration is expected.

| App ID | Official endpoint | Configuration |
| --- | --- | --- |
| hubspot | https://mcp.hubspot.com | MERI_MCP_HUBSPOT_CLIENT_ID and MERI_MCP_HUBSPOT_CLIENT_SECRET from a HubSpot **MCP auth app**; existing provider-selected permissions |
| airtable | https://mcp.airtable.com/mcp | Dynamic registration and browser authorization; selected resources; data.records:read, schema.bases:read, data.recordComments:read, workspacesAndBases:read |
| monday | https://mcp.monday.com/mcp | Dynamic registration and PKCE; Capiro public integration approval; MERI_MCP_MONDAY_ENABLED=true only after setup is ready for acceptance |
| google-drive | https://drivemcp.googleapis.com/mcp/v1 | MERI_MCP_GOOGLE_DRIVE_CLIENT_ID and MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET; drive.readonly, offline access; API enablement, consent verification and Developer Preview access; MERI_MCP_GOOGLE_DRIVE_ENABLED=true only after setup is ready for acceptance |

HubSpot and Airtable remain enabled by default when global OAuth configuration and required credentials are present. Each has its own MERI_MCP_HUBSPOT_ENABLED / MERI_MCP_AIRTABLE_ENABLED kill switch. New providers default off until operator setup. Disabling a provider blocks schema exposure and execution; existing credentials are retained and remain disconnectable.

Common settings: CLIO_MCP_ENABLED, CLIO_MCP_OAUTH_REDIRECT_URI, OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY, OAUTH_TOKEN_ENCRYPTION_KEY_VERSION. The callback must match the actual deployed URL and every provider registration exactly.

Provider references:
- [monday public integration and dynamic registration](https://developer.monday.com/api-reference/docs/mcp-dynamic-client-registration)
- [Google Drive MCP setup](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server)
- [HubSpot MCP auth apps and PKCE](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)
- [Airtable permissions and resource selection](https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server)

## Inspect the actual running deployment

Run the deployed-configuration job with the existing AWS_READONLY_GHA_ROLE_ARN, or run
`python3 scripts/inspect-meri-connectors.py` in an authenticated operator environment.

The script describes capiro-dev/capiro-dev-api (the cluster serves production), the exact active task definition and deployments, safe callback/flag values, presence of credentials and secret references. It never calls GetSecretValue or prints credential values. Preserve its sanitized JSON report as acceptance evidence.

The read-only role may lack IAM policy inspection. A blocked result must remain blocked until an operator verifies that the ECS execution role can load each referenced secret and decrypt it with the relevant KMS key. Confirm actual secret version population without placing values in logs, PRs, fixtures or reports.

Complete provider console setup using the approved callback. Do not repurpose Google Workspace mail/calendar credentials without verifying the same project's Drive API, preview access and consent configuration.

## Automated checks

### Engagement meeting-prep worker configuration

Inspect the active `capiro-dev-engagement-api` task definition as well as the main API when validating meeting-prep reads. The worker uses managed MCP authentication even though the main API owns the OAuth callback route. It requires `CLIO_MCP_OAUTH_REDIRECT_URI` with the **same provider-registered value as the main API**, matching OAuth state/encryption secret references, and the same intended provider availability flags and user/tenant allowlists. Do not derive an alternative callback from the worker's host.

Run `python3 scripts/inspect-meri-connectors.py --service capiro-dev-engagement-api --output-file meri-engagement-connector-deployment.json` to preserve the worker's inspection separately. `missingManagedOAuthConfiguration` must be empty for managed reads to work. The report shows allowlist presence without publishing its members; compare the actual intended scope separately.

On September 20, 2026, the live worker had the secrets and monday allowlists but lacked this callback setting. `MeriMcpOAuthService.isConfigured()` returned false, so authenticated schema discovery exposed no tools and prep reported monday unavailable. Engagement task revision 113 added the callback already in API revision 407, preserving the image and all other settings; rollback was revision 112. Future task-definition replacements must preserve these settings. A successful explicit-board prep then retrieved six actual monday items/subitems with citations. This is scoped meeting-prep verification, not acceptance of every provider or a public connector rollout.

The meri-connectors-verify workflow runs focused API/OAuth, orchestrator and frontend tests, then API/web/orchestrator typechecks and builds. It also checks formatting. Fix failures and record the final tested commit and run URL before release.

Added regression coverage includes exact read-only names, discovery failure, cached disconnect/disable gates, provider isError failures, token encryption, preserved refresh tokens, late refresh after disconnect, OAuth scope selection, signed cancellation replay, paginated discovery, popup closure/blocking, repeated clicks, identity changes and draft continuity.

Unit mocks do not establish that a provider accepts the OAuth registration, refresh tokens or requested scopes. Verify these live below.

## Live fixture matrix

Use test accounts and non-sensitive fixtures with distinct known markers. Record fixture identifiers, expected markers, user/tenant (redacted), test timestamp, deployed revision, discovered tool names/schemas, read tool result and the Meri response. Never record tokens, auth codes, client secrets or PKCE verifiers.

| Check | HubSpot | Airtable | monday.com | Google Drive |
| --- | --- | --- | --- | --- |
| Fresh sign-in and consent | Not run | Not run | Not run | Not run |
| Cancel provider consent | Not run | Not run | Not run | Not run |
| Blocked popup / closed popup | Not run | Not run | Not run | Not run |
| Repeated clicks produce one flow | Not run | Not run | Not run | Not run |
| Authenticated tools/list and reviewed schemas | Not run | Not run | Not run | Not run |
| Actual fixture search/read through Meri | Not run | Not run | Not run | Not run |
| Expired access token refresh | Not run | Not run | Not run | Not run |
| Revoked provider access and reconnect | Not run | Not run | Not run | Not run |
| Disconnect blocks the next call immediately | Not run | Not run | Not run | Not run |
| Page refresh and undock/reopen | Not run | Not run | Not run | Not run |
| Draft, staged attachments, window state preserved | Not run | Not run | Not run | Not run |
| Change Capiro user and tenant | Not run | Not run | Not run | Not run |
| Provider errors fail the check | Not run | Not run | Not run | Not run |
| Unknown/write/API-execution tools denied | Not run | Not run | Not run | Not run |

Fixture prompts:
- HubSpot: find the fixture contact and deal and report the known company/deal-stage marker. Start with get_user_details to establish user permissions, then search_crm_objects/get_crm_objects.
- Airtable: find the selected fixture base and read records containing its marker. Repeat using selected-base and interface-only grants; inaccessible bases must remain inaccessible.
- monday.com: summarize the fixture board including a known item, update and document marker.
- Google Drive: search for the fixture document and read its known content marker, including a recent-file query. Check sharing/ACL restrictions against a document outside the granted user's access.

Capture live tool schemas and compare with the explicit allowlists before enabling additional tool names. Core HubSpot CRM reads are explicitly listed; unrestricted API execution and all_monday_api remain blocked. A new read-looking name is not sufficient evidence to allow a tool.

## Release and rollback

Only release after **all four** providers pass every required acceptance check. If provider approvals, credentials, test accounts or execution infrastructure remain unavailable, keep the PR and release gate blocked and record the exact dependency.

Use the existing API/web/orchestrator release process. Start from the live task definitions, preserve every unrelated environment entry and secret reference, record prior task definition ARNs and image digests, and add only the reviewed managed-provider configuration. Do not replace the running task definition with a partial source configuration.

Follow existing infrastructure drift restrictions; do not run a CDK deployment against a rollback-failed stack. A rollback restores the recorded task definitions/images and prior provider flags. Retain encrypted personal connections and the existing database schema.
