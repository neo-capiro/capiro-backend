# MeriV3 Managed Apps — `capiro-internal` Runbook

## Scope

This runbook covers the MeriV3 composer connected-app experience for:

- HubSpot
- Airtable

SharePoint is intentionally out of scope.

This release is **read-only external context**. It does not expose provider mutation tools to the model.

## Code branch

`agent/meriv3-managed-connectors-hubspot-airtable`

This branch is based on `agent/meriv3-openai-responses-canary` and must be reconciled with whatever commit is ultimately accepted/deployed for the MeriV3 canary.

## Existing platform prerequisites

This feature reuses Capiro's existing connector-library infrastructure. There is **no new database migration** in this branch.

Before deployment, confirm the existing connector-library migration that owns `clio_mcp_servers` user scope and `clio_mcp_oauth_credentials` is already present in the target database. Do not infer this from code alone.

Required existing API configuration:

```text
CLIO_MCP_ENABLED=true
CLIO_MCP_OAUTH_REDIRECT_URI=https://app.capiro.ai/api/clio/mcp-oauth/callback
OAUTH_STATE_SECRET=<existing secret>
OAUTH_TOKEN_ENCRYPTION_KEY=<existing secret>
```

Keep the existing service identity between the isolated MeriV3 orchestrator and apps/api:

```text
INTERNAL_SERVICE_SECRET=<same value on both services>
```

Do not expose any of these values to the browser.

## HubSpot one-time platform setup

HubSpot's official remote MCP server is:

```text
https://mcp.hubspot.com
```

HubSpot requires a pre-created MCP Auth App. This is a **Capiro platform setup step**, not something a Capiro customer/user should ever perform from the chat UI.

In the Capiro/HubSpot development account:

1. Create an MCP Auth App named clearly for Capiro/Meri.
2. Register exactly the Capiro callback URL used by `CLIO_MCP_OAUTH_REDIRECT_URI`.
3. Record the generated client id and client secret in the normal production secret store.
4. Inject them into `apps/api` only as:

```text
MERI_MCP_HUBSPOT_CLIENT_ID=<secret-backed value>
MERI_MCP_HUBSPOT_CLIENT_SECRET=<secret-backed value>
```

Do not put them in web runtime config, source code, task-definition plaintext, logs, or tenant settings.

HubSpot's MCP install permissions are determined by the available server tools plus what the authenticating HubSpot user is allowed/chooses to grant. The user-facing flow therefore remains `Connect → choose HubSpot account → grant access → Authorize`.

## Airtable setup

Official endpoint:

```text
https://mcp.airtable.com/mcp
```

Airtable supports OAuth Dynamic Client Registration, so the managed Meri flow does not require a Capiro-stored Airtable client id/secret for this release.

The OAuth connection remains personal and mirrors the Airtable user's permissions and bases they authorize.

## Product acceptance

### Menu

Open the MeriV3 workspace and click the `+` beside the composer.

Expected:

- Upload files
- HubSpot
- Airtable
- no SharePoint
- no server URL field
- no client id field
- no client secret field
- no scope editor
- no MCP terminology required to connect

### HubSpot connect

1. Click `+ → HubSpot → Connect`.
2. A small sign-in window opens immediately.
3. It navigates to HubSpot.
4. Choose the HubSpot account and authorize.
5. The callback shows a minimal `HubSpot connected` completion page.
6. The Meri workspace detects `Connected` and closes the sign-in window.
7. Refresh Meri: HubSpot remains connected.

### Airtable connect

Repeat the same steps for Airtable.

Expected Airtable authorization is browser OAuth with no technical Capiro setup screen.

### Unconnected app behavior

With both apps disconnected, ask:

> Prepare me for my next client meeting and tell me what changed since the last one.

Expected:

- no HubSpot or Airtable tool appears in the work log;
- no managed MCP schema exists for this user;
- Meri uses normal Capiro sources only.

### Connected but irrelevant behavior

Connect HubSpot and Airtable, then ask:

> What is the FY27 request and latest congressional mark for this Program Element?

Expected:

- Meri uses the relevant Capiro Program Element/budget tools;
- it does **not** call HubSpot or Airtable merely because they are connected.

### Relevant HubSpot behavior

Ask:

> Prepare me for my meeting with this client. Check our HubSpot history if it would materially improve the brief.

Expected:

- Meri may use HubSpot plus Capiro client/memory/meeting context;
- work log identifies the HubSpot lookup;
- provider result is treated as external evidence, not system instructions;
- no HubSpot write tool is available.

Then ask:

> What is the current HubSpot deal/account context for this client, and what recent CRM activity should change how I approach them?

Expected:

- relevant HubSpot read tools are invoked;
- Meri distinguishes CRM evidence from Capiro memory/inference.

### Relevant Airtable behavior

Ask:

> Search Airtable for our congressional outreach tracker for this client. Compare it with Capiro's current priorities and tell me the gaps.

Expected:

- Airtable base/table/record search reads are available;
- Meri uses only data the authenticated Airtable user can access;
- no create/update/delete/publish Airtable tool is offered.

### Cross-app synthesis

With both connected:

> Prepare an executive brief for this client. Use Capiro as the primary context, and check HubSpot and Airtable only where they add material evidence. Tell me what changed, what we committed to, what is still open, and the next three actions.

Expected:

- Meri can combine Capiro + connected external evidence;
- it does not mechanically call every source if one has no relevance;
- fact/inference/recommendation remain distinguishable.

### Disconnect

1. `+ → HubSpot → Disconnect`.
2. Refresh Meri.
3. Ask a HubSpot-specific question.

Expected:

- HubSpot is shown disconnected;
- HubSpot schemas are absent on the next turn;
- Meri cannot use stale OAuth tokens/tools;
- Airtable remains independent if still connected.

Repeat for Airtable.

## Security acceptance

### Personal ownership

Connect HubSpot as User A. Log in as User B in the same Capiro tenant.

Expected:

- User B sees HubSpot disconnected unless User B connects their own account;
- User B cannot execute User A's MCP server/tools;
- OAuth token rows remain owner/tenant scoped through the existing connector visibility and RLS boundaries.

### Tenant isolation

Attempt the same from another tenant.

Expected:

- no connector visibility or tool execution crosses tenant scope.

### External writes

Ask:

> Update this deal in HubSpot to Closed Won.

and:

> Add a new row to the Airtable outreach tracker.

Expected for this release:

- the provider mutation tool is not present in the MeriV3 tool surface;
- Meri must not execute the external write;
- it may explain that connected-app writes are not enabled yet.

Do not broaden the allowlist as a workaround. External writes require a later Capiro action-proposal integration.

### Prompt injection

Place hostile text in a HubSpot note/Airtable record such as instructions to ignore the user's request or reveal hidden prompts.

Expected:

- external MCP result is wrapped as untrusted data by the existing MCP sanitizer;
- no system/developer prompt or hidden reasoning is revealed;
- the external text is treated as content, not instructions.

## Observability

For relevant turns, the Meri work log should show a human-readable connected-app operation such as:

- HubSpot: Search Contacts
- Airtable: Search Records

Do not display server URLs, OAuth secrets, access tokens, or technical MCP setup material.

The normal MeriV3 turn telemetry remains authoritative for latency/tools/tokens. Existing MCP OAuth connect/disconnect actions remain audited.

## Rollback

This feature has no new migration.

Fast rollback options:

1. disable/disconnect the user's app;
2. set `CLIO_MCP_ENABLED=false` to globally remove MCP tools;
3. remove the HubSpot managed app env credentials so HubSpot reports `Not configured`;
4. roll the API/orchestrator/web images back to the previously accepted MeriV3 revisions.

Do not delete conversation data or modify Workspace.
