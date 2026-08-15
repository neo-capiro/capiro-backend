# Workspace vNext — Backend Gaps

> Every item below is UI functionality the design requires and the vNext backend
> contract does not cover. Items dated 2026-08-12 were verified against the
> backend branch `agent/workspace-document-agent-backend-vnext` at SHA
> `b1bb241b39e577afa82887f6cec43e3704e222b7`. Items dated **2026-08-15** were
> re-verified (or newly found) directly against `apps/workspace/src` on
> `agent/workspace-vnext-audit-fixes` (rebased onto current `origin/main`,
> head `aff50f990`) during the full stabilization audit. Items marked CLOSED
> were resolved by source inspection or fixed this session; both are noted
> explicitly.

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

## §2. Generation-mode persistence — **CLOSED: fixed 2026-08-15**

`PatchAgentDto` already declared `generation?: { mode }`, but
`DocumentAgentService.patchAgentState` never read `patch.generation` — the
field validated and was silently dropped. This was a LIVE bug: the routed
editor's mode chip (`WorkspaceEditorStabilized.tsx` `cycleMode`) sends this
PATCH on every click, so the toggle appeared to do nothing (the optimistic
local state would revert once the cache re-read the unchanged server value).

**Fix**: `document-agent.service.ts` `patchAgentState` now applies
`patch.generation.mode` to `state.generation.mode` under the same
optimistic-revision lock as every other field. Regression test:
`document-agent.service.spec.ts` → "persists generation.mode instead of
silently dropping it".

**UI action**: No longer needed — the mode chip now round-trips for real.

## §3. Assumption confirm / reject — **no semantic route**

`AgentAssumption.status` is `open|confirmed|rejected`, but the only write
path is a whole-brief `PUT`, which races with concurrent edits and loses
provenance of who confirmed.

**UI action**: Assumption confirm/reject uses `PUT /brief` with the full
`assumptions[]` array. This is the only available path. Noted as a limitation.

## §4. Conflict resolution — **no semantic route (re-confirmed 2026-08-15, harder evidence)**

`ContextConflict.resolved` and `.resolution` exist in state, `context/analyze`
produces conflicts, and `context/approve` requires them resolved — but nothing
writes a resolution semantically. The only path is `PATCH /drafts/:d/agent`
against the whole `contextPlan`, which is a blunt write.

**2026-08-15 re-verification**: `ResolveContextConflictDto` (expectedRevision,
resolution, keptItemId?, excludedItemIds?) is fully defined in
`document-agent.dto.ts` but has **zero references anywhere else** — no
controller route, no service method calls it. `ContextConflict.resolved`/
`.resolution` are only ever *read* (in `document-agent-quality.service.ts`,
filtering `!c.resolved` for the `agent:source_conflicts` check), **never
written to `true`/set anywhere in the codebase**. A conflict, once created,
can never be marked resolved by any current code path — not a UI gap, a
genuine missing backend route. The DTO shape above is exactly what the route
should accept if/when it's added — no guessing required for that follow-up.

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

## §9. Share-link options — **confirmed; frozen-snapshot bug found and fixed 2026-08-15**

`POST …/share-links` accepts `{ label?, expiresInDays?, versionId?,
idempotencyKey? }`. Expiry length is supported. Guest comments are enabled
by default (rate limited server-side). The overlay offers expiry selection
only.

**2026-08-15 finding, fixed**: `versionId` was accepted and stored on the
share link, and returned back from `getByToken` — but `getByToken` never
actually *read* `WsDocVersion.snapshot`. It always served the live,
possibly-since-edited `draft.config`, silently defeating the entire point of
pinning a version before sharing (editing the draft after sharing changed
what an already-distributed public link showed). The frontend's share
creation flow already did the correct thing (creates a version snapshot,
then passes its id as `versionId`) — this was purely a backend bug. **Fixed**:
`ShareLinkService.getByToken` now loads and serves the frozen
`WsDocVersion.snapshot` whenever `link.versionId` is set. Regression test:
`delivery.spec.ts` → "serves the frozen version snapshot, not the live
draft, when versionId is pinned".

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

## §13. Guest comments in the internal thread — **CLOSED: fixed 2026-08-15**

Previously guest comments from the public share were NOT persisted. The
`POST /public/workspace-share/:token/comments` endpoint sanitized the text and
returned `{ ok: true, text: sanitized }`, but never wrote to any table. Rate
limiting was in-memory but rejection returned HTTP 200 with an `{error}`
field rather than a real 429. `GuestCommentDto.text` had no `@MaxLength` —
the 2000-char cap was silent truncation, not validation.

**Fix (2026-08-15)**:
- Added `WsGuestComment` Prisma model (migration
  `20260815000000_ws_guest_comment`): `id, tenantId, draftId, shareLinkId,
  body, guestName?, createdAt`. Guests carry no identity — no Clerk user, no
  tenant membership — so this is the durable "guest marker" record, never
  returned by the public endpoint itself.
- `ShareLinkService.addGuestComment` persists the sanitized body + optional
  sanitized guest-supplied display name (not a verified identity).
- Rate-limit rejection now throws a real `HttpException(429,
  HttpStatus.TOO_MANY_REQUESTS)` instead of returning 200 with an error field.
- `GuestCommentDto` now validates `@MaxLength(2000)` on `text` and
  `@MaxLength(200)` on `name` (previously accepted-but-silently-capped).
- Added `GET /drafts/:draftId/delivery/guest-comments` (authenticated,
  `canRead`-gated) so the internal team can actually retrieve guest feedback.

**Remaining gap (not closed)**: no frontend panel renders the new
`guest-comments` endpoint yet — the Delivery overlay does not yet show a
"Guest feedback" list. The backend half of "persist somewhere the internal
team can actually see" is done (an authenticated, real endpoint exists); the
UI half was out of this session's scope. Follow-up: add a simple read-only
list in the Delivery inspector tab, query-keyed `['ws','guest-comments',draftId]`.

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

## §28. Live verification against currently-deployed main (2026-08-15) — confirms this PR fixes real, currently-live defects

Tested the live os.capiro.ai (task-def running exactly `origin/main` HEAD
`7793c638d` — confirmed via `window.__CAPIRO_CONFIG__.releaseSha` in the
browser, i.e. NOT stale, and does NOT include this audit branch's unmerged
commits) as an authenticated user (Neo Martinez). Three real, reproducible
defects observed, all matching exactly what this audit branch's
already-existing commits are designed to fix:

1. **No Clerk-aware transport on main.** `GET /workspace-api/drafts?scope=all`
   and `GET /workspace-api/template-studio/blueprints` both return real `401
   {"message":"Missing or malformed Authorization header"}` on every load —
   confirmed `window.fetch` remains the native, unpatched function on the
   `/workspace` page (main has no `transport-bridge.ts`; it's a new file only
   on this audit branch). The Library UI **silently renders "NO DOCUMENTS
   YET"** instead of surfacing the auth failure — a 401 looks identical to an
   empty library today. This is precisely the defect the audit branch's
   `api/transport-bridge.ts` + `WorkspaceApiBoundary` commit fixes.
2. **Public share is not isolated on main.** Navigating to
   `/share/nonexistent-token` renders the "This document is no longer
   available" message correctly, but wrapped inside the **full authenticated
   app shell** (top bar, left rail, Neo's profile) — main has no
   `main.tsx`-level bypass. This is precisely what the audit branch's `main.tsx`
   commit ("mount public shares outside Clerk") fixes. (Not verified
   logged-out in this session — would need a separate unauthenticated
   session; the structural shell-wrapping itself is visible regardless of
   login state.)
3. **Legacy route `/workspace/library` is swallowed by generic vNext
   matching on main.** Instead of falling through to the canonical
   `LibraryPage`, it renders "Document Agent not initialized" — main is
   literally treating the literal path segment `"library"` as a draft ID.
   The offered "Open in standard editor" fallback button does not recover
   (same broken page after clicking). This is precisely what the audit
   branch's UUID-aware `DRAFT_ROUTE` regex (`WorkspaceVNextRoutes.tsx`) fixes
   — main lacks that guard entirely.

**Conclusion**: these are not hypothetical, PR-description-only claims — this
audit branch's routing/transport/public-share commits fix real, currently-
live breakage on the deployed vNext workspace surface. Did not exhaustively
re-test every screen live (network access to a real dev draft's full
brief→context→outline→generation flow was not exercised this session to
avoid creating test artifacts in a user-facing environment); the three
findings above were chosen because they concretely validate the PR's
highest-severity claimed fixes.

## §19. Comment delete had no ACL check — **CLOSED: fixed 2026-08-15**

`CommentsService.remove()` scoped only by tenantId — no
`collaborators.assertCan` call at all, unlike every other mutation in this
module. Any authenticated tenant member (not just a collaborator with access
to the specific draft) could delete any comment on any document in the
tenant, including drafts they had zero role on.

**Fix**: deleting another person's comment now requires `canReview`
(owner/editor/reviewer — the same bar as resolving). An author may always
delete their own comment (still gated on `canComment`, i.e. must have access
at all). Regression tests: `src/comments/comments.service.spec.ts`.

## §20. Context-item PATCH had no ACL check and ignored expectedRevision — **CLOSED: fixed 2026-08-15**

`AgentContextItemController.patchContextItem` (`PATCH
/drafts/:draftId/context/:itemId`) performed no collaborator ACL check (only
tenant+draft scoping), and `PatchContextItemDto.expectedRevision` was
declared but never read by the service — validated, then silently ignored.

**Fix**: now requires `canEdit` via `loadDraft(...)` and enforces
`expectedRevision` against the draft's current agent-state revision when
supplied (409 `DOCUMENT_AGENT_REVISION_CONFLICT` on mismatch). Regression
tests: `document-agent.service.spec.ts` → `patchContextItem` describe block.
Note: this route currently has zero live callers (only the unreachable
`WorkspaceEditorVNext.tsx` prototype calls it — see §23) — fixed anyway since
it's part of the documented contract and the DTO already implied the
guarantee.

## §21. Generation status/sectionResults were fabricated on the happy path — **CLOSED: fixed 2026-08-15**

`generate()` and `retryGeneration()` discarded the real `GenerationRunSummary`
returned by `GenerationService` (which carries genuine `status:
'complete'|'complete_with_warnings'|'partial'|'failed'` and per-section
`sectionResults`) and hardcoded `lastRun.status = 'complete'` on any
non-throwing path — including a run where individual sections failed (which
does not throw). This directly violated the "render server truth, never
fabricate" governance principle.

**Fix**: both methods now read the engine's real result and populate
`lastRun.status`/`completedAt`/`sectionResults` from it; `state.status` maps
`complete_with_warnings→complete` (the coarser agent-status enum has no
separate value) and `partial`/`failed` pass through unchanged. Regression
tests: `document-agent.service.spec.ts` → "generation mode routing" describe
block (3 new tests, including a back-compat case where the engine returns no
run summary at all).

## §22. Generation stage progress (`stages[]`) has no backing data — **OPEN, not fixed**

`DocumentAgentRunSummary.stages: GenerationStage[]` (the `preflight /
evidence_plan / narrative_plan / drafting / editorial_pass / assurance /
snapshot / complete` vocabulary the UI spec describes) is hardcoded to `[]`
at run creation and never updated anywhere in `document-agent.service.ts`.
`GenerationService` has no internal stage-level instrumentation to surface —
this isn't a wiring gap, the granularity doesn't exist in the generation
engine at all today.

**UI action (already correct, no change needed)**: the frontend's
`normalizeGenerationStages` already filters to server-emitted stages only
("Never manufacture status or progress") — it just never receives any. The
generation panel shows section-level results (which ARE real, see §21) but
no stage-by-stage progress. Building real stage instrumentation into
`GenerationService` is a backend feature, not a frontend fix — out of scope
for this audit.

## §23. Two prototype files are unreachable dead code with a non-canonical, buggy contract — **OPEN, recommend deletion, not done this session**

`apps/web/src/vnext/pages/workspace/editor/WorkspaceEditorVNext.tsx` (and its
private `api/client.ts` DTOs / `types/agent.ts` types it alone uses) are not
reachable from routing — `WorkspaceVNextRoutes.tsx` lazy-imports a binding
*named* `WorkspaceEditorVNext` but the loader actually resolves
`WorkspaceEditorStabilized`'s export, shadowing the real file. This orphaned
prototype reinvents a **wrong** contract: `WorkspaceComment.text` (canonical
is `body`), a `Collaborator` role union missing `commenter`, and an
`EditLock.heldBy === 'me'` sentinel-string comparison (canonical is the
server-computed `heldByMe` boolean — no client-side ID comparison anywhere
in real code). None of this affects the live app today, but it is exactly
the kind of surface a future "quick fix" could resurrect incorrectly, since
the naming makes it look like the real component.

**Recommendation**: delete `WorkspaceEditorVNext.tsx` and the client.ts
functions/types that only it calls (confirmed zero other callers by grep:
`getDraft`, `getComments`/`addComment`/`patchComment`/`deleteComment`,
`getCollaborators`/`addCollaborator`/`updateCollaborator`/
`removeCollaborator`, `getVersions`/`createVersion`/`restoreVersion`,
`detectAnonymize`, `promoteToMemory`, `getPublicShare`, `addGuestComment`,
plus `getDocuments`/`getLock`/`heartbeat`/`releaseLock`/`requestLock`/
`patchDocument`/`createDocument`/`exportDocx`/`exportPdf`/`cancelGeneration`,
called only by the dead prototype). Not done this session — deleting ~half
of `client.ts` plus a 2000+-line component is a meaningfully-sized, separate
cleanup change; flagging rather than rushing it in alongside correctness
fixes.

## §24. Proposal fields: no diff data, and outline-revision proposals are a no-op — **OPEN, confirmed via source**

`WsAgentProposal` has no `affectedSections`/`lockedSectionsTouched` field —
the frontend's optimistic rendering of those from `payload.*` (GAPS.md §10
originally) will never receive them; only the generic fallback message will
ever render for outline/content proposals. Separately, and more seriously:
`reviseOutline` creates a proposal whose payload is `{ instruction,
outlineSnapshot: state.outline.sections }` where `outlineSnapshot` is the
**pre-revision** section list — the reasoning gateway's `reviseArtifact`
method exists but `reviseOutline` never calls it or anything else that
actually rewrites the outline. Accepting an `outline_revision` proposal
today just re-applies the identical sections that already existed — a
functional no-op. Also: staleness detection (`PROPOSAL_STALE`, 409) is only
implemented for `outline_revision` and `content_revision` — `quality_fix:*`
proposals have no staleness check at all, and accepting one applies nothing
(no apply-payload branch exists for that type).

**UI action**: no frontend change needed — the routed `ProposalReview`
already refuses to fake a diff when `payload.after` is absent. This is
purely a backend gap in the outline-revision generation logic; logged, not
fixed (implementing a real outline-rewrite call is a reasoning-gateway
change, out of scope for a stabilization audit).

## §25. Edit-lock role-gate asymmetry — **OPEN, low severity**

`acquire`/`takeOver` correctly require `canEdit`. `status`, `heartbeat`,
`release`, and `request` have no collaborator role gate beyond tenant scope
— in particular, `request()` lets any tenant member (not necessarily a
collaborator with any role on this specific draft) register a lock-access
request against the current holder. Not fixed this session — no live UI path
was found that depends on tightening it, and the blast radius is limited to
a notification/request record, not a content mutation. Logged for a future
pass.

## §26. Quick/Standard/Max share one generation pipeline — **OPEN, confirmed, matches known limitation**

`document-agent.service.ts`'s `generate()` has an `if (mode === 'max') {…}
else {…}` branch that calls the identical `GenerationService
.generateAllSections(...)` with identical arguments in both branches —
vestigial. `GenerationService.generateAllSections` takes no mode parameter
at all; `mode` is stored/labeled on the agent state only. Frontend already
avoids overclaiming (the mode chip is a plain label with no marketing copy
about a distinct pipeline). No fix — this is a real product feature gap
(building genuinely different pipelines per mode), not a stabilization bug.

## §27. Generation cancel is not cooperative — **OPEN, confirmed, frontend already handles it correctly**

`cancelGeneration` only flips agent-state JSON (`activeRunId = undefined`,
`status = 'partial'`) — no call into `GenerationService`, no
`AbortController` reachable from the caller. `generate()` `await`s the
generation call synchronously within the same request, so a concurrent
cancel cannot interrupt in-flight provider calls. **No fix needed on the
frontend**: the routed `GenerationPanel` renders no Cancel button at all,
with a static note explaining cancellation is unavailable once generation
has started. Logged as a backend limitation (real cooperative cancellation
would need an `AbortController` threaded through `GenerationService`'s
per-section loop) — out of scope for this audit.
