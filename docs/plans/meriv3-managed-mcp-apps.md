# MeriV3 Managed Apps — HubSpot + Airtable

## Goal

Add a ChatGPT-style connected-app experience to the MeriV3 chat workspace. A normal user clicks the composer `+`, chooses **HubSpot** or **Airtable**, signs into the provider, and returns to Meri. The user never enters an MCP URL, OAuth client id, client secret, or scope string.

This phase intentionally skips SharePoint.

## Product contract

- Surface exists only in the MeriV3 workspace.
- `+` menu contains:
  - Upload files
  - HubSpot
  - Airtable
- Connections are **personal/user scoped**. Each provider acts with the permissions of the user who authorized it.
- Connection state is visible as Connected / Connect / Reconnect.
- OAuth opens in a small browser window. The Meri workspace remains usable and polls for completion.
- Repeated clicks do not create a second Capiro integration system; this is a simplified face over the existing MCP connector/OAuth store.
- Unconnected apps contribute **zero** tools to Meri.
- Connected apps contribute only their current, allowlisted, **read-only context tools** in this release.
- The model decides whether to call a connected-app tool for a turn. No external content is automatically fetched or injected into every prompt.
- MCP responses remain explicitly untrusted external data and pass through the existing prompt-injection sanitizer.
- No provider write tool is exposed in this phase. External writes can be added later only after they are bound to Capiro durable action proposals and human approval.

## Provider implementation

### HubSpot

- Official remote MCP endpoint: `https://mcp.hubspot.com`.
- HubSpot requires a pre-created MCP auth app and OAuth 2.1 + PKCE.
- Capiro owns the app credentials server-side via:
  - `MERI_MCP_HUBSPOT_CLIENT_ID`
  - `MERI_MCP_HUBSPOT_CLIENT_SECRET`
- The end user sees only the HubSpot authorization UI.
- Connection is created with `scope=user`, even though the older general connector catalog default is tenant-scoped.

### Airtable

- Official remote MCP endpoint: `https://mcp.airtable.com/mcp`.
- Airtable supports browser OAuth and dynamic client registration.
- Capiro uses the existing MCP SDK OAuth provider/PKCE flow, so the user sees only Airtable login/consent.
- Connection is personal/user scoped.

## Runtime flow

1. MeriV3 asks apps/api for native Capiro tool schemas as today.
2. MeriV3 additionally asks a new V3-only endpoint for connected managed-app schemas.
3. apps/api builds that list from connectors visible to the authenticated user.
4. Only connected HubSpot/Airtable rows are considered.
5. Their live MCP `tools/list` output is filtered to the managed read-only allowlist.
6. Meri receives those namespaced schemas alongside native Capiro tools.
7. If the model selects one, the isolated orchestrator delegates it back to a V3-only, service-secret-protected apps/api endpoint.
8. apps/api re-verifies user/tenant visibility, verifies the tool is still a current read-only managed-app tool, executes it through `MeriMcpService`, sanitizes the result, and returns it.

## Security invariants

- Browser never sends a provider server URL, OAuth app secret, model id, tenant id, or arbitrary tool name outside the server-returned set.
- Tenant/user identity is derived from existing Capiro auth.
- HubSpot/Airtable connections are personal; another user in the tenant cannot use them.
- Existing RLS and AES-256-GCM OAuth credential storage remain authoritative.
- OAuth state remains signed and single-use with PKCE.
- Only the isolated orchestrator may invoke the V3 managed MCP execution endpoint; normal user bearers alone are insufficient when the service-secret gate is enforced.
- External results remain wrapped as untrusted data.
- Mutating MCP tools are fail-closed and never enter the model tool surface in this phase.

## Read-only classification

Airtable uses an explicit allowlist of official read tools. HubSpot is dynamic because the provider's available tools vary with account permissions; the managed layer permits conservative read prefixes (`get`, `list`, `search`, `read`, `fetch`, `query`, `lookup`, `describe`) and explicitly rejects known mutating prefixes (`create`, `update`, `delete`, `archive`, `publish`, `send`, `associate`, `remove`, `add`, `set`, `execute`).

Unknown HubSpot tools are not exposed until classified.

## Acceptance

- MeriV3 `+` shows Upload files, HubSpot, Airtable; no SharePoint.
- Legacy/non-V3 chat still uses the ordinary attachment control.
- HubSpot/Airtable connection requires only provider login/consent.
- Connected state survives popup close/reopen and page refresh.
- Disconnect removes the app's tools from the next turn.
- A user with no connected apps gets no MCP schemas.
- Connecting HubSpot does not expose Airtable tools and vice versa.
- Read queries can use connected apps when relevant.
- Unrelated prompts do not force an MCP call.
- No HubSpot/Airtable mutation tool is offered to the model.
- Cross-user and cross-tenant connector execution is refused.
- Workspace, Strategy, in-editor, and other Meri surfaces remain unchanged.
