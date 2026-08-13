# vNext handoff gaps

Last verified: 2026-08-12.

This file contains only gaps that were confirmed while wiring the vNext Meri workspace to the existing production contracts. A row here means the UI must not pretend the capability is complete.

| Gap | Current verified behavior | Required follow-up | Deployment impact |
| --- | --- | --- | --- |
| Draft-only external communication invariant | `send_email` and `reply_email` are registered side-effecting tools. Current policy marks outbound email restricted/WARN and action proposals can execute the persisted tool after approval. | Decide the product boundary and enforce it server-side. For strict draft-only Meri, remove/block external-send tools for the applicable runtime and provide an explicit draft-artifact tool instead. Do not rely on hiding UI controls. | **Known product-policy gap.** This vNext PR adds no send path and no approval bypass, but it cannot truthfully claim “external send is impossible.” |
| Managed SharePoint app | `GET /api/clio/v3/capabilities` currently advertises only `hubspot` and `airtable`. | Add a reviewed SharePoint managed-app definition, OAuth configuration and read-only schema before exposing it in vNext. | No fake SharePoint card is rendered. |
| Shared thread-rail failed-load ordering | `MeriWorkspaceThreadRail` sets the selected conversation/session before its message fetch succeeds. That component is shared with the current app. | Fix in a dedicated canonical-runtime PR with regression coverage, or extract a common transactional thread loader. | vNext hard-link bootstrap is fixed to commit state only after a successful fetch. Shared rail behavior remains unchanged to avoid expanding this deployment into canonical Meri. |
| Reloaded message provenance parity | The shared durable-history loader currently restores message body, attachments and analysis-chart references. Live citations/verification are delivered by the stream controller, but the existing history loader does not reconstruct every live provenance field. | Define/persist the durable message provenance payload and hydrate citations/verification/grounding caveats from it on reload. | vNext does not fabricate citations on reload. Live streamed citations remain authoritative. |
| Dedicated integrations route vs generic MCP catalog | The user-facing vNext route uses the reviewed `/api/clio/v3/apps` contract. The lower-level `/api/clio/mcp-catalog` and `/mcp-servers` APIs expose a broader connector-library model. | Keep the managed-app route as the end-user default. Add catalog entries only after each provider has a reviewed simple-login UX and MeriV3 read-only tool surface. | No server-address/secret fields are exposed in vNext. |

## Closed by this implementation

- `/meri/new` is record-free until first Send.
- First Send delegates to the existing conversation creator rather than introducing a parallel persistence path.
- `/meri/t/:id` is addressable and hydrates from server-authoritative history.
- Failed hard links do not mutate the active shared session before the server response is validated.
- `/meri` resolves to the newest durable thread or `/meri/new` when history is empty.
- `/meri/integrations` is a real managed-app surface backed by the existing MeriV3 OAuth/status contract.
- vNext Meri bypasses the global product shell and reuses the established full-window workspace/runtime.
- Existing canonical Meri controller and shared thread rail are not modified by this PR.
- vNext Meri presentation shell replaces MeriWorkspaceWindow with a new 3-column layout (top bar + left thread rail + center conversation + right context rail) matching the MERI-HANDOFF.md §5.1 and the Untitled UI HTML prototype.

## New gaps opened by the vNext Meri presentation shell

| Gap | Current verified behavior | Required follow-up | Deployment impact |
| --- | --- | --- | --- |
| Active context items in the right rail | The context/fact store API exists but the vNext shell does not yet wire thread-scoped context selection to the right rail's ACTIVE CONTEXT section. The rail renders the explicit empty state ("No context included. Meri will answer from client scope alone.") rather than fabricating items. | Wire the context store to the rail: read included items, render tiles, wire remove actions, and open the manage-context sheet. | The rail's empty state is honest but not yet functional. No data is fabricated. |
| Connected source live count in the right rail | The managed MCP apps hook (`useManagedMcpApps`) is available via the integrations page, but the right rail shows a static representation of HubSpot and Airtable rather than live connected-source counts from the tenant's capabilities. | Wire the rail's CONNECTED SOURCES section to the same managed-apps data the integrations page uses, so the count and dot states are live. | The rail shows correct lettered tiles but may not reflect real-time connection state. |
| Reasoning mode chip in thread header | The legacy MeriWorkspaceWindow reads and writes the reasoning mode via `/api/clio/v3/conversations/:id/reasoning-mode`. The vNext shell renders a static STANDARD mode pill but does not yet wire the reasoning-mode dropdown. | Port the reasoning-mode read/write logic from the legacy component into VNextMeriConversation's thread header. | The mode pill is display-only; no incorrect state is persisted. |
| Quick actions in the right rail | The three quick actions send a raw message via `controller.sendMessage`. The prototype intends them to trigger specific grounded prompts with context-entry chips. | Wire quick actions to send real grounded prompts (with context-entry chips), not just their label text. | Quick actions function as message shortcuts but do not yet carry the intended context semantics. |
| Command palette (⌘K) | The vNext shell registers the ⌘K shortcut as a no-op. The prototype specifies a full command palette searching threads, context items, connected sources, and actions. | Build the command palette component with real search over threads/context/sources/actions. | ⌘K does nothing visible; no incorrect behavior. |
| Source detail sheet | Source chips in the message source strip are clickable buttons but do not open the source-detail sheet (the sheet is not yet built). | Build the source-detail sheet (`?panel=source&id=:sourceId`) with provenance, evidence, and the include-in-context toggle. | Source chips are present and accessible but their click target is a no-op. |
| Context management sheet | The "Manage context" button in the right rail is a no-op. The context sheet (`?panel=context`) is not yet built. | Build the manage-conversation-context sheet with server-side search, included/suggested context, and apply/cancel. | The button is visible but does not open the sheet. |
| Rail collapse persistence | The context rail collapse state is component-level (useState) and does not persist per user across sessions. | Persist the collapse preference via the window-state preference endpoint or a logged adapter. | Collapse resets on refresh; no data issue. |
