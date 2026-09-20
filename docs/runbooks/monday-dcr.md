# monday.com personal connections in Meri

Meri uses the hosted monday MCP server at `https://mcp.monday.com/mcp` with dynamic
client registration, authorization-code OAuth, and PKCE S256. Each connection is
owned by a Capiro tenant and user; the backend registers and encrypts the client
credentials and tokens. Customers only select Connect and authorize their own
monday account. No static monday client ID, client secret, or personal API token
is needed in deployment configuration.

The OAuth callback in the running API and public registration application is
`https://app.capiro.ai/api/clio/mcp-oauth/callback`. Keep this value exact. Use
live protected-resource and authorization-server discovery rather than copying
authorization URLs from documentation. On September 20, 2026 discovery advertised
issuer `https://auth.monday.com/mcp` and registration at
`https://auth.monday.com/oauth_ms/oauth/register`.

## Release configuration

- Existing prerequisites: `CLIO_MCP_ENABLED`, `CLIO_MCP_OAUTH_REDIRECT_URI`,
  `OAUTH_STATE_SECRET`, and `OAUTH_TOKEN_ENCRYPTION_KEY`.
- `MERI_MCP_MONDAY_ENABLED=true` enables the connector. It defaults off.
- For internal qualification, set **both** `MERI_MCP_MONDAY_ALLOWED_USER_IDS` and
  `MERI_MCP_MONDAY_ALLOWED_TENANT_IDS` to explicit comma-separated IDs. If either
  setting is present, both must match; empty values and wildcards grant nothing.
- After public-release approval and live acceptance, remove **both** qualification
  allowlists while retaining the enabled flag. Each customer still authorizes
  separately and can access only their own monday permissions.
- Preserve other environment values, secret references, roles, and the immutable
  previous task/image when preparing a release. Do not deploy an older complete
  API image over a newer runtime.

## Qualification

1. Fresh Connect must perform DCR automatically and display the Capiro Meri name,
   the exact callback, PKCE, and a signed state bound to the user, tenant, and
   authorization issuer.
2. Callback errors, issuer mismatches, replayed state, cancelled sign-in, and
   missing/expired grants must never appear as Connected.
3. Authenticated discovery must expose only reviewed read tools. Read an existing
   board and its items through Meri; retain item links in the response. Unknown
   tools, writes, and unrestricted API execution remain blocked.
4. Test refresh (including JWT expiry without `expires_in`), revoked access,
   reconnect, disconnect, popup closure, and repeated clicks.
5. Refresh/reopen Meri and verify the personal connection persists. Confirm a
   different user or tenant cannot see or execute the connection.

A successful HTTP 201 DCR response proves technical registration, **not** approval
of the public integration application. The application was submitted and its
success page verified; approval remains a separate release dependency until
monday confirms it. See the [public integration requirements](https://developer.monday.com/api-reference/docs/mcp-dynamic-client-registration).
