# Workspace vNext — Backend Gaps

> Every item below is UI functionality the design requires and the vNext backend
> contract (PR #922) does not cover. Each was verified against the backend branch
> `agent/workspace-document-agent-backend-vnext` at SHA
> `b1bb241b39e577afa82887f6cec43e3704e222b7` (rebased on main `178628386`)
> on 2026-08-12. Items marked CLOSED were resolved by source inspection.

## §1. Theme / design changes after initialize — **no route** (CLOSED: read-only)

`PATCH /drafts/:draftId/agent` accepts `theme` as a field, so the Design tab
can technically write through it. However, there is no semantic theme-change
endpoint, and without theme CRUD (§15) there is nothing meaningful to change
it to. The Design tab ships **read-only** — the paper picker updates the local
preview only and does not persist, because persisting an unversioned
browser-only theme blob would silently change what a pinned document renders
as.

**UI action**: Design tab is read-only. Paper picker shows live preview only.
Save is disabled with explanation.

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
| Rail collapse persistence | Browser-local via `meri-prefs.ts` (`capiro.meri.vnext.context-rail`). No per-user preference endpoint. | Add a per-user preference API if chrome must follow the user across devices. | Collapse/section state is device-local. |

## Gaps opened by Meri v3 undocked pixel-parity (2026-08-14)

### GAP-MERI-WINDOW-CHROME — window chrome is not persisted server-side
- **Module / surface:** Meri undocked workspace — dock / maximise / restore
- **What the UI needs:** per-user `undocked | maximized | docked`
- **Proposed contract:** GET/PUT `/api/clio/preferences/meri-window` → `{ chrome }`
- **Evidence of absence:** grepped `apps/api/src/meri` and `apps/web/src/components/chat` for window-preference / undocked persistence endpoints; only in-memory `chat-store` surfaceMode + localStorage in `MeriOverlay.tsx` exist.
- **Shipped instead:** named adapter `apps/web/src/vnext/meri/meri-prefs.ts` (`readWindowChrome` / `writeWindowChrome`)
- **Blocking?** No — degrades across devices
- **Estimated backend surface:** 1 preference field, 2 endpoints
- **Owner:** unassigned

### GAP-MERI-SAVED-PROMPTS — no saved-prompt list for the rail
- **Module / surface:** Thread rail → SAVED PROMPTS
- **What the UI needs:** user-owned saved prompt rows
- **Proposed contract:** reuse whatever the current app uses for the prompt library / firm skills; do not invent one
- **Evidence of absence:** grepped `apps/web/src/vnext/meri` and `apps/web/src/components/chat` for saved-prompt adapters; rail previously used hardcoded strings. No dedicated list endpoint is wired to this rail.
- **Shipped instead:** distinct empty state (`NO SAVED PROMPTS`) — no fabricated rows
- **Blocking?** No
- **Estimated backend surface:** confirm existing skills/library list or add one
- **Owner:** unassigned

### GAP-MERI-WORKSPACES — no workspace list for the rail
- **Module / surface:** Thread rail → WORKSPACES
- **What the UI needs:** named workspace rows with kind + add
- **Proposed contract:** reuse existing workspace / connected-app list if one is the product meaning of this section
- **Evidence of absence:** no Meri workspace-list adapter in `vnext/meri` or `components/chat`
- **Shipped instead:** distinct empty state (`NO WORKSPACES YET`); add control opens integrations
- **Blocking?** No
- **Estimated backend surface:** confirm existing list or add one
- **Owner:** unassigned

### GAP-MERI-DUPLICATE-CONTEXT — duplicate context to new chat
- **Module / surface:** Thread row menu
- **What the UI needs:** copy current thread context into a new chat
- **Proposed contract:** TBD — no existing verb found
- **Evidence of absence:** grepped `apps/api/src/meri` for duplicate/clone conversation; only archive/restore/update title exist
- **Shipped instead:** menu item visible and disabled with an honest title
- **Blocking?** No
- **Estimated backend surface:** 1 mutation
- **Owner:** unassigned

### GAP-MERI-GROUNDING-STATEMENT — `groundingStatement` is not on the chat message
- **Module / surface:** Assistant source strip (ungrounded)
- **What the UI needs:** render the server's `groundingStatement` verbatim
- **Proposed contract:** include `groundingStatement` on persisted messages and the stream
- **Evidence of absence:** `ChatMessage` in `chat-store.ts` has citations / verification / groundingCaveat only; `meri-route-state.ts` `PersistedMessage` has no field; stream handler in `useMeriChatController.ts` has no `groundingStatement` event
- **Shipped instead:** existing honest copy “No retrieved sources were attached to this answer.” plus `NOT GROUNDED` stamp. Not client-composed as a substitute for a server sentence.
- **Blocking?** No for ship; yes for exact §6.4 wording
- **Estimated backend surface:** 1 field on message DTO + stream
- **Owner:** unassigned

### GAP-MERI-PERSISTED-CITATIONS — history hydration drops citations
- **Module / surface:** Assistant source strip after refresh
- **What the UI needs:** persisted `sourceRefs` / citations on `/messages`
- **Proposed contract:** map whatever the messages DTO already returns
- **Evidence of absence:** `historyMessage()` in `VNextMeriWorkspace.tsx` only maps attachments + chart artifacts
- **Shipped instead:** live stream citations still render; hydrated history shows the ungrounded strip unless the DTO is extended in this adapter later
- **Blocking?** No for this presentation pass (no payload-shape change)
- **Estimated backend surface:** confirm DTO; if present, map it
- **Owner:** unassigned

### GAP-MERI-TITLE-FIRST-MESSAGE — list DTO has latest, not first, user text
- **Module / surface:** Recent row titles
- **What the UI needs:** first user message when title is `Chat session`
- **Proposed contract:** list rows include `firstUserMessage` or a generated title
- **Evidence of absence:** `MeriConversation.latestMessage` only
- **Shipped instead:** fallback to `latestMessage.body` trimmed to 48 chars
- **Blocking?** No
- **Estimated backend surface:** 1 optional list field
- **Owner:** unassigned

## §2. Generation-mode persistence — **unconfirmed**

The `PatchAgentDto` accepts `documentType`, `blueprintPin`, `theme`, `goal`,
`phase`, `status` — but does NOT explicitly include `generation`. The mode
chip writes `generation.mode`, but it is unclear if the backend persists this
field through the generic `PATCH /agent` route.

**UI action**: Mode chip updates local state optimistically. If `PATCH /agent`
with `generation: { mode }` is rejected, mode falls back to client-only state.
No silent failure — the chip reflects what the server returns.

## §3. Assumption confirm / reject — **no semantic route**

`AgentAssumption.status` is `open|confirmed|rejected`, but the only write
path is a whole-brief `PUT`, which races with concurrent edits and loses
provenance of who confirmed.

**UI action**: Assumption confirm/reject uses `PUT /brief` with the full
`assumptions[]` array. This is the only available path. Noted as a limitation.

## §4. Conflict resolution — **no semantic route**

`ContextConflict.resolved` and `.resolution` exist in state, `context/analyze`
produces conflicts, and `context/approve` requires them resolved — but nothing
writes a resolution semantically. The only path is `PATCH /drafts/:d/agent`
against the whole `contextPlan`, which is a blunt write.

**UI action**: Conflict resolution UI is present but the resolve action is
**disabled** with an explanation: "Conflict resolution endpoint not
available. Contact your administrator to resolve conflicts manually." The
conflict is displayed, counted, and blocks approval — but the UI cannot
write a resolution. This is honest rather than faking resolution via a
whole-contextPlan PATCH.

## §5. Library list projection — **shape unconfirmed, N+1 risk**

`GET /drafts` is a legacy list route. It does not project
`config.documentAgent.{phase,status}` or a cached quality score. The library
would need one `GET /agent` per row to show phase/status/quality.

**UI action**: Phase, status, and quality columns render `—` (em dash) for
all library rows. No N+1 fan-out. The columns are present but show unknown
until the list endpoint projects these fields.

## §6. Global search over documents — **no route**

`GET /drafts` supports `sector` and `scope` only — no `q` parameter.

**UI action**: Global search in the top bar does not search documents on the
`/workspace` route. The search scope is limited to other modules (clients,
issues, programs, people) as in the existing shell.

## §7. Anonymize apply — **detect only**

`POST /drafts/:d/anonymize/detect` returns candidates; nothing applies a
replacement.

**UI action**: Anonymize overlay shows detected candidates as review-only.
The `Replace` action is disabled with explanation "Apply endpoint not
available — review only."

## §8. Packet document ordering — **not modelled**

`PATCH /drafts/:d/documents/:docId` covers name and body; no `order`/
`position` field.

**UI action**: Packet tabs render in server order. No drag-to-reorder.

## §9. Share-link options — **confirmed**

`POST …/share-links` accepts `{ label?, expiresInDays?, versionId?,
idempotencyKey? }`. Expiry length is supported. Guest comments are enabled
by default (rate limited server-side). The overlay offers expiry selection
only.

## §10. Proposal payload shape — **unspecified**

`GET /agent/proposals` is documented as "list proposals" with no payload
schema. The `payload` field on `WsAgentProposal` is a JSON blob. The frontend
renders a before/after diff from `payload.before` and `payload.after` if
present, affected sections from `payload.affectedSections`, and locked
section flags from `payload.lockedSectionsTouched`. If the backend does not
populate these, the overlay shows the proposal type and instruction with a
generic "review proposed changes" message.

## §11. Blueprint usage count — **not in the list route**

`GET /template-studio/blueprints` does not return a `pinnedDocCount`.

**UI action**: The "Pinned docs" column shows `—` until the list route
projects the count.

## §12. Blueprint test result shape — **CLOSED: shape confirmed**

`POST …/versions/:versionId/test` returns a typed result:
`{ passed: boolean; intake: Record<string, unknown>; outline: Array<{ id: string; title: string; targetWords: { min: number; max: number } }>; errors: string[] }`.

**Evidence**: `template-studio.service.ts` `testVersion()` method return type
(lines 282-291). The shape is deterministic: intake resolves each question,
outline maps sections to `{ id, title, targetWords }`, errors list validation
failures. On failure (422), the body is `{ message, errors }`.

**UI action**: The frontend renders the returned `outline` (section count,
titles, target word ranges) and `intake` (resolved answers). On 422, display
the error list. No generic "Test passed/failed" fallback needed.

## §13. Guest comments in the internal thread — **CLOSED: not persisted**

Guest comments from the public share are NOT persisted to the database. The
`POST /public/workspace-share/:token/comments` endpoint sanitizes the text and
returns `{ ok: true, text: sanitized }`, but never writes to `wsComment` or
any other table. Rate limiting is in-memory (token-hash keyed map with 2000-char
sanitize).

**Evidence**: `delivery.controller.ts` `addGuestComment()` (line 99) calls
`shareLink.checkRateLimit()` and `shareLink.sanitize()` but no `prisma.create()`.
`share-link.service.ts` `checkRateLimit()` (line 139) and `sanitize()` (line 155)
are pure functions — no persistence.

**UI action**: Guest comments from the public share do NOT appear in the internal
comments drawer. The guest comment form shows "Comment submitted" but the comment
is transient — it is not stored and cannot be retrieved later. This is a backend
limitation: guest comments need a persistence layer.

## §14. Notification deep links — **CLOSED: draftId present**

The `WsNotification` model includes `draftId` (nullable UUID), `draftTitle`,
`collaboratorId`, `actorName`, `role`, `actionable`, and `kind` fields. The
`GET /notifications` endpoint returns these fields directly.

**Evidence**: `prisma/schema.prisma` `model WsNotification` (line 319):
`draftId String? @map("draft_id") @db.Uuid`. Also `notifications.service.ts`
`create()` writes `draftId`, `draftTitle`, `collaboratorId`, `actorName`,
`role`, `actionable`.

**UI action**: The notification bell CAN construct deep links to drafts using
`draftId`. Link target: `/workspace/${draftId}`. Display `draftTitle` and
`actorName` in the notification item. `actionable` flags invite-style
notifications that have accept/decline buttons.

## §15. Document themes have no CRUD at all — **no routes** (largest gap)

No routes exist for:
```
GET    /template-studio/themes
POST   /template-studio/themes
GET    /template-studio/themes/:themeId
POST   /template-studio/themes/:themeId/versions
PATCH  /template-studio/themes/:themeId/versions/:versionId
POST   /template-studio/themes/:themeId/versions/:versionId/publish
POST   /template-studio/themes/:themeId/versions/:versionId/retire
```

**Evidence**: Searched `apps/workspace/src/template-studio/template-studio.controller.ts`
— only blueprint routes exist. No `ThemeController` or theme-related routes in
the delivery or document-agent modules either.

**UI action**: The Document Themes surface is read-only. `Save draft` and
`Publish theme` are disabled with the reason: "Theme CRUD endpoints are not
available. Themes are read-only until the backend adds theme routes." The
paper picker and letterhead preview show the `defaultTheme` from the pinned
blueprint. No unversioned browser-only theme blob is saved.

## §16. Brand asset upload — **no route**

No upload endpoint and no asset record exist.

**Evidence**: Searched all controllers in PR #922 — no `POST /template-studio/assets`
or similar.

**UI action**: The firm mark drop target in the theme editor is disabled with
"Brand asset upload not available."

## §17. Exports must honour the theme — **PARTIALLY CLOSED**

`export.service.ts` reads `cfg.letterhead` from the draft's `config` blob (not
from a theme model). It honors: `letterhead.custom` (boolean), `letterhead.logoDataUrl`
(PNG/JPEG data URL), `letterhead.firmName`, `letterhead.firmAddr`. Both DOCX and
PDF exports render the letterhead. The draft-level `config.letterhead` IS used.

However, there are no theme CRUD routes (§15) and no theme model — so the new
Design tab's theme/paper picker has no persistent backend target. The legacy
draft-level letterhead config is separate from the vNext theme system.

**Evidence**: `export.service.ts` line 447: `const cfg = draft.config as
Record<string, unknown>` and line 452: `const letterhead = cfg.letterhead as …`.
Both `buildDocx()` (line 447) and `buildPdf()` (line 661) read `cfg.letterhead`.

**UI action**: Export is available. The export overlay notes: "Export includes
the document's letterhead (firm name, address, logo) from the draft config.
Theme paper/margin settings are not reflected in the export."

## §18. Feature flag off — **coherent degradation**

When `WORKSPACE_DOCUMENT_AGENT_VNEXT_ENABLED=false` or a draft has no
`documentAgent` state:
- The library still works (uses existing `GET /drafts`).
- The editor renders the existing canonical workspace editor (falls through
  via `VNextRouter` Outlet).
- The agent panel and inspector show an explanatory empty state with
  "Initialize document agent" (if permitted).
- No crash, no blank pane.

This is not a gap — it is implemented as §9.9 of the handoff.
