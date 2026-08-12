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
