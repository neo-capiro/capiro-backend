# Meri vNext API inventory

Verified against `main` on 2026-08-12. This inventory records the existing contracts reused by the vNext Meri workspace; it is not a proposed second backend.

## Conversation substrate

| Capability | Contract | vNext use |
| --- | --- | --- |
| List durable threads | `GET /api/clio/conversations` | Boot `/meri`, populate the thread rail, resolve newest thread. |
| Create thread | `POST /api/clio/conversations` | Existing `useMeriChatController.handleNewSession`; vNext defers this until first Send on `/meri/new`. |
| Read/update thread | `GET/PATCH /api/clio/conversations/:id` | Existing runtime metadata and client assignment. |
| Archive/restore | `PATCH /api/clio/conversations/:id/archive`, `/restore` | Existing runtime; vNext returns to record-free `/meri/new` after archive. |
| Load messages | `GET /api/clio/conversations/:id/messages` | Hard-link hydration for `/meri/t/:id`. State is committed only after a successful response. |
| Stream a turn | `POST /api/clio/conversations/:id/stream` (SSE) | Existing controller owns send, stop/abort, trust steps, citations, research offers, artifacts and approval events. Server aborts generation when the client disconnects. |
| Search history | `GET /api/clio/conversations/search?q=&limit=` | Available to the existing runtime; vNext thread rail currently filters its loaded durable list locally. |

## Client scope and context

- `GET /api/clients` supplies the scope selector.
- `PATCH /api/clio/conversations/:id` persists `clientId`; the existing controller deliberately does not fall back to the global client filter for an already-created conversation.
- `GET /api/clio/context-packets/conversation/:id/latest` returns the latest user- and tenant-scoped context packet for chat/GA chat.
- `GET /api/clio/context-packets/:id` reloads a durable context packet by id.
- Context-packet reads are user scoped and return an explicit degraded/unavailable payload rather than fabricated context when no packet is present.

## Attachments, artifacts, citations and analysis

- `POST /api/clio/attachments` uploads a file (10 MB controller limit).
- `POST /api/clio/attachments/resolve-text` resolves extracted text for authorized attachment ids.
- `GET /api/clio/artifacts/:id/download` regenerates stored Office artifacts.
- `GET /api/clio/artifacts/:id/image` serves the legacy analysis image.
- `GET /api/clio/analysis-artifacts/:artifactId` and `/image` are the MeriV3 user-scoped analysis readers.
- The chat SSE `done` event can carry citations; the existing shared controller is authoritative for live citation rendering and grounding caveats.

## Deep Research

- `GET/POST /api/clio/research`
- `GET/DELETE /api/clio/research/:id`
- `POST /api/clio/research/:id/clarify`
- `POST /api/clio/research/:id/plan/stream` (SSE)
- `POST /api/clio/research/:id/stream` (SSE)
- `GET /api/clio/research/:id/export/word`
- `GET /api/clio/research/:id/export/html`

The existing `useMeriChatController` already owns research mode, clarification questions, inline “Run as Deep Research” offers and completed-report actions. vNext reuses it instead of creating a second research state machine.

## Reasoning modes and MeriV3 capabilities

- `GET /api/clio/v3/capabilities` reports the MeriV3 runtime, supported `fast`, `standard`, `deep`, `max` modes, managed apps and visual-analysis capability.
- `GET /api/clio/v3/conversations/:conversationId/reasoning-mode`
- `PATCH /api/clio/v3/conversations/:conversationId/reasoning-mode`

Reasoning mode is persisted on the durable conversation; it is not a browser-only preference.

## Managed apps / integrations

The end-user MeriV3 managed-app contract is deliberately non-technical:

- `GET /api/clio/v3/apps`
- `POST /api/clio/v3/apps/:appId/connect`
- `POST /api/clio/v3/apps/:appId/disconnect`
- OAuth completes through `GET /api/clio/mcp-oauth/callback` using signed state.
- The current MeriV3 capabilities contract advertises `hubspot` and `airtable` only.
- `GET /api/clio/v3/mcp-tool-schemas` exposes only the reviewed MeriV3 read surface to the isolated orchestrator.
- `POST /api/clio/v3/mcp-tools/:toolName` is internal-service guarded.

A lower-level connector library also exists (`/api/clio/mcp-catalog`, `/mcp-servers`, refresh, OAuth start/disconnect), but the vNext user-facing integrations route intentionally uses the managed-app contract so the user never supplies server URLs or secrets.

## Memory

- `GET /api/clio/memory/recent`
- `GET /api/clio/memory`
- `PATCH /api/clio/memory/:id`
- `DELETE /api/clio/memory/:id`
- `POST /api/clio/memory/:id/suggest-correction`

The existing controller owns the learned-memory UI and undo/forget behavior. Shared-scope writes remain subject to the established authority rules.

## Governed actions and approvals

New write approvals use opaque proposal ids:

- orchestrator-only `POST /api/clio/action-proposals`
- browser-safe `GET /api/clio/action-proposals?conversationId=`
- `POST /api/clio/action-proposals/:proposalId/approve`
- `POST /api/clio/action-proposals/:proposalId/dismiss`

The browser does not send a tool payload back on approve; the server reuses the persisted, policy-bound proposal. The older fingerprint approval endpoints mounted on `MeriController` are explicitly retired compatibility routes.

## Important safety finding

The current server still registers `send_email` and `reply_email` as side-effecting tools. The shipped policy classifies outbound email as `WARN` / restricted and can execute it after explicit approval. Therefore the backend does **not** currently satisfy a stronger “Meri can never externally send; draft-only” product invariant. vNext does not add a new send control or bypass the approval gate, but that invariant requires a separate server/product-policy change; see `docs/handoff/GAPS.md`.
