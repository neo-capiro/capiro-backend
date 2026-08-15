# Workspace vNext API Inventory

> Source of truth for the Workspace Document Agent vNext frontend. Re-verified
> directly against `apps/workspace/src` on branch `agent/workspace-vnext-audit-fixes`
> (rebased onto `origin/main`) during the 2026-08-15 stabilization audit. Rows
> below are marked **RE-VERIFIED 2026-08-15** where source was re-read this
> session; unmarked rows are carried over from the 2026-08-12 pass and were not
> re-touched. All routes are under `/workspace-api`.

## Status

- **Backend module**: `apps/workspace/src` (in-repo, not a separate PR — the
  2026-08-12 note about PR #922/a standalone backend branch is stale; the
  document-agent module lives directly in `apps/workspace/src/document-agent`
  on `main`).
- **Feature flag**: `WORKSPACE_DOCUMENT_AGENT_VNEXT_ENABLED` (env, default
  `false`). Per-tenant via `tenants.settings_jsonb`.
- **MERIV3_ORCHESTRATOR_URL**: Required for reasoning routes. Without it,
  reasoning routes return 503.
- **Validation**: global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`
  (`apps/workspace/src/main.ts`) — DTOs are strictly enforced, extra fields rejected.
- **Auth**: every controller below is class-level `@UseGuards(TenantGuard)` unless noted
  (the two `Public*Share*` routes have no guard, by design). Role checks beyond
  tenant scope are `collaborators.assertCan(...)` against `role-policy.ts` predicates
  — a failed predicate throws `ForbiddenException` (403).

## 1. Catalog & Recommendation

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| GET | `/document-agent/catalog` | — | `{ documentTypes: [{id,label,product}] }` | — | Creation flow: Type grid |
| POST | `/document-agent/recommend` | `{ goal: string, client?: string }` | `{ documentType, recommendedBlueprints[], recommendedTheme, questions[], rationale }` | — | Creation flow: Ask Meri |

## 2. Draft Agent State

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| GET | `/drafts/:draftId/agent` | — | `{ state: AgentState }` | 404 | Editor: all panels |
| POST | `/drafts/:draftId/agent/initialize` | `{ documentType?, blueprintPin?, theme?, goal? }` | `{ state: AgentState }` | — | Creation flow: Create document |
| PATCH | `/drafts/:draftId/agent` | `{ expectedRevision, documentType?, blueprintPin?, theme?, goal?, generation?: { mode }, phase?, status? }` | `{ state: AgentState }` | 409 `DOCUMENT_AGENT_REVISION_CONFLICT` | Editor: mode chip, phase transitions |

**RE-VERIFIED 2026-08-15 — CLOSED**: `PatchAgentDto` already declared
`generation?: { mode?: 'quick'|'standard'|'max' }`, but
`DocumentAgentService.patchAgentState` never read `patch.generation` — the
field validated successfully and was silently dropped, so the editor's mode
chip (`WorkspaceEditorStabilized.tsx` `cycleMode`, a LIVE routed control) sent
a real PATCH that had no effect. **Fixed this session**:
`document-agent.service.ts` now applies `patch.generation.mode` to
`state.generation.mode` under the same optimistic-revision lock as every
other field. See GAPS.md §2 (now closed).

## 3. Conversation

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| GET | `/drafts/:draftId/agent/messages` | — | `{ messages: AgentMessage[] }` | — | Agent panel thread |
| POST | `/drafts/:draftId/agent/messages` | `{ text, phase, expectedRevision, idempotencyKey?, scope? }` | `{ message, phase, revision, questions?, stateSummary?, proposal?, allowedActions? }` | 409, 503 | Agent panel composer |

## 4. Brief

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| PUT | `/drafts/:draftId/agent/brief` | `{ expectedRevision, objective?, audience?, desiredAction?, subject?, centralArgument?, evidenceInstructions?, tone?, targetPages?, deadline?, assumptions? }` | `{ state: AgentState }` | 409 | Brief tab: field edits, assumption confirm/reject |
| POST | `/drafts/:draftId/agent/brief/synthesize` | `{ expectedRevision }` | `{ state: AgentState }` | 409, 503 | Brief tab: Synthesize |
| POST | `/drafts/:draftId/agent/brief/approve` | `{ expectedRevision }` | `{ state: AgentState }` | 409 | Brief tab: Approve |
| POST | `/drafts/:draftId/agent/brief/reopen` | `{ expectedRevision }` | `{ state: AgentState }` | 409 | Brief tab: Edit brief |

**Gap**: No semantic route for assumption confirm/reject — only whole-brief PUT.
See GAPS.md §3.

## 5. Context

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| POST | `/drafts/:draftId/agent/context/recommend` | `{ expectedRevision }` | `{ state: AgentState }` | 409, 503 | Context tab: Recommend |
| POST | `/drafts/:draftId/agent/context/analyze` | `{ expectedRevision }` | `{ state: AgentState }` | 409, 503 | Context tab: Analyze |
| POST | `/drafts/:draftId/agent/context/approve` | `{ expectedRevision }` | `{ state: AgentState }` | 409 (unresolved conflicts) | Context tab: Approve |
| PATCH | `/drafts/:draftId/context/:itemId` | `{ payload: Record, expectedRevision? }` | `{ item }` | 409 `DOCUMENT_AGENT_REVISION_CONFLICT`, 403 | Context tab: item metadata |
| GET | `/drafts/:draftId/context` | — | `{ items: ContextItem[] }` | — | Context tab: item list |
| POST | `/drafts/:draftId/context` | `{ kind: 'source'\|'news'\|'free-text', payload }` | created item | — | Agent panel: + attach |
| DELETE | `/drafts/:draftId/context/:itemId` | — | — | — | Context tab: remove |
| GET | `/drafts/:draftId/context-used` | — | used context | — | Canvas: Context used link |

**RE-VERIFIED 2026-08-15**: The context-item PATCH route is served by a
*separate* controller, `AgentContextItemController` (lives in
`document-agent.controller.ts`, not `context.controller.ts` — the plain
`context` module only has GET/POST/DELETE). Two real defects found and fixed
this session:
1. `expectedRevision` was declared on `PatchContextItemDto` but the service
   method never read it — no optimistic-concurrency enforcement despite the
   DTO advertising it. **Fixed**: now enforced against the draft's current
   agent-state revision when supplied.
2. The service performed **no collaborator ACL check at all** (only
   tenant+draft scoping) — any tenant member, not just a collaborator with
   edit access on that specific draft, could patch a context item's payload.
   **Fixed**: now requires `canEdit` via `loadDraft(...)`, matching every
   other mutation in this module.

**Gap**: No semantic conflict-resolution route — **confirmed still true**.
`ResolveContextConflictDto` is declared in `document-agent.dto.ts` but has
zero references anywhere else (no controller route, no service method).
`ContextConflict.resolved`/`.resolution` are only ever *read* (in the quality
check), never written. See GAPS.md §4 (unchanged, now with harder evidence).

## 6. Outline

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| POST | `/drafts/:draftId/agent/outline/generate` | `{ expectedRevision }` | `{ state: AgentState }` | 409, 503 | Outline tab: Generate |
| PUT | `/drafts/:draftId/agent/outline` | `{ expectedRevision, sections[] }` | `{ state: AgentState }` | 409 | Outline tab: edit |
| POST | `/drafts/:draftId/agent/outline/revise` | `{ expectedRevision, instruction }` | `{ proposalId, type }` | 409, 503 | Outline tab: Revise with Meri |
| POST | `/drafts/:draftId/agent/outline/approve` | `{ expectedRevision }` | `{ state: AgentState }` | 409 | Outline tab: Approve |

## 7. Proposals

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| GET | `/drafts/:draftId/agent/proposals` | — | `{ proposals: AgentProposal[] }` | — | Proposal overlay |
| POST | `/drafts/:draftId/agent/proposals/:proposalId/accept` | `{ expectedRevision }` | `{ state: AgentState }` | 409 `PROPOSAL_STALE` | Proposal overlay: Accept |
| POST | `/drafts/:draftId/agent/proposals/:proposalId/reject` | `{ expectedRevision, note? }` | `{ state: AgentState }` | 409 | Proposal overlay: Reject |

**RE-VERIFIED 2026-08-15 — shape now confirmed (not merely observed empty)**:
`WsAgentProposal` row fields (schema + service): `id, tenantId, draftId,
createdById, type, status, baseRevision, baseHash, payload(Json), createdAt,
decidedAt?, decidedById?`. **There is no `affectedSections` or
`lockedSectionsTouched` field anywhere in the schema or service** — the
frontend's optimistic rendering of those from `payload.affectedSections`/
`payload.lockedSectionsTouched` (GAPS.md §10) will never actually receive
them; the generic fallback message is the ONLY path that will ever render
for the fields this backend produces. Stale detection (`PROPOSAL_STALE`,
409) is real but **only implemented for `outline_revision` and
`content_revision` proposal types** — `quality_fix:*` proposals have no
staleness check at all. Separately: `outline_revision` proposals carry a
payload of `{ instruction, outlineSnapshot }` where `outlineSnapshot` is the
**pre-revision** section list (not an AI-revised "after") — accepting one is
currently a functional no-op (re-applies identical sections). This is a real
backend gap, not a frontend rendering gap; logged in GAPS.md as a new item.

## 8. Generation

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| POST | `/drafts/:draftId/agent/generate` | `{ expectedRevision, mode?, idempotencyKey? }` | `{ state: AgentState }` | 409, 422 | Canvas: Start generation |
| GET | `/drafts/:draftId/agent/generation` | — | `{ runId, mode, status, startedAt, completedAt?, stages[], sectionResults? }` | — | Canvas: poll status |
| POST | `/drafts/:draftId/agent/generation/retry` | `{ expectedRevision, sectionIds? }` | `{ state: AgentState }` | 409 | Canvas: Retry failed |
| POST | `/drafts/:draftId/agent/generation/cancel` | `{ expectedRevision }` | `{ state: AgentState }` | 409 | Canvas: Cancel |

**RE-VERIFIED 2026-08-15 — three real findings:**

1. **Truth-telling bug, fixed this session.** `generate()` and
   `retryGeneration()` previously **discarded** the real
   `GenerationRunSummary` returned by `GenerationService.generateAllSections`/
   `retryFailedSections` (which carries the real `status:
   'complete'|'complete_with_warnings'|'partial'|'failed'` and per-section
   `sectionResults`) and hardcoded `lastRun.status = 'complete'` on any
   non-throwing path. A run where individual sections failed (which does not
   throw) was reported to the client as flat `'complete'`. **Fixed**: both
   methods now read the engine's real `generationRun` and populate
   `lastRun.status`/`lastRun.completedAt`/`lastRun.sectionResults` from it;
   `state.status` maps `'complete_with_warnings'→'complete'` (the coarser
   agent-status enum has no separate value) and `'partial'`/`'failed'` pass
   through unchanged. Regression tests added in
   `document-agent.service.spec.ts`.
2. **`stages[]` has no backing data — genuine gap, not fixed.**
   `DocumentAgentRunSummary.stages` (the `preflight/evidence_plan/
   narrative_plan/drafting/editorial_pass/assurance/snapshot/complete`
   vocabulary) is hardcoded to `[]` at run creation and never updated —
   `GenerationService` has no internal stage-level instrumentation to surface.
   The frontend already does the right thing (`normalizeGenerationStages`
   filters to server-emitted stages only, comment: "Never manufacture status
   or progress") — it just never has anything to show. Logged as a real
   backend limitation in GAPS.md, not something client code can honestly fix.
3. **Quick/Standard/Max confirmed to share one pipeline.**
   `document-agent.service.ts`'s `generate()` has an `if (mode === 'max') {…}
   else {…}` that calls the **identical** `generateAllSections(...)` in both
   branches with identical arguments — the branch is vestigial.
   `GenerationService.generateAllSections` takes no mode parameter at all.
   `mode` is stored/labeled only. Frontend correctly does not claim otherwise
   (the mode chip is a plain label, no marketing copy). Logged in GAPS.md.
4. **Cancel confirmed non-cooperative** — `cancelGeneration` only flips
   agent-state JSON (`activeRunId = undefined`, `status = 'partial'`); no
   call into `GenerationService`, no `AbortController` reachable from the
   caller, and `generate()` `await`s the generation call synchronously in the
   same request, so a concurrent cancel cannot interrupt in-flight work.
   Frontend already handles this correctly: **no Cancel button is rendered**
   in the routed `GenerationPanel`; a static note explains cancellation is
   unavailable. No fix needed on the frontend; backend limitation logged in
   GAPS.md.

## 9. Quality

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| GET | `/drafts/:draftId/agent/quality` | — | `{ score, readiness, blockers[], recommendations[], checks[] }` | — | Quality tab |
| POST | `/drafts/:draftId/agent/quality/issues/:issueId/fix` | `{ expectedRevision, instruction? }` | `{ proposalId }` | 409, 503 | Quality tab: Fix with Meri |

## 10. Delivery, Approval & Share

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| POST | `/drafts/:draftId/delivery/preflight` | — | `{ requiresApproval: boolean, approvalPolicy: { clientFacingApprovalRequired, permittedApproverRoles[] }, isStale: boolean }` | — | Delivery overlay |
| POST | `/drafts/:draftId/delivery/approval-requests` | `{ versionId?, notes?, idempotencyKey? }` | approval request | 409 (pending or already-decided) | Delivery overlay |
| POST | `/drafts/:draftId/delivery/approval-requests/:requestId/decision` | `{ decision, note? }` | — | — | Delivery overlay |
| POST | `/drafts/:draftId/delivery/share-links` | `{ label?, expiresInDays?, versionId?, idempotencyKey? }` | `{ shareId, token, expiresAt }` (token returned ONCE) | — | Delivery overlay: Create share |
| DELETE | `/drafts/:draftId/delivery/share-links/:shareLinkId` | — | — | — | Delivery overlay: Revoke |
| GET | `/public/workspace-share/:token` | — | `{ draftId: '', versionId, docTitle, sections: [{id,title,content}] }` (sanitized, no auth guard) | 404 (expired/revoked/unknown — same response shape for all) | Public share route |
| POST | `/public/workspace-share/:token/comments` | `{ text (max 2000), name? (max 200) }` | `{ ok: true }` | 429 (rate limited, real `HttpStatus.TOO_MANY_REQUESTS`) | Public share: guest comment |
| GET | `/drafts/:draftId/delivery/guest-comments` | — | `{ id, tenantId, draftId, shareLinkId, body, guestName, createdAt }[]` | 403 | Delivery overlay: guest feedback (NEW — added this session) |

**RE-VERIFIED 2026-08-15 — three real findings, two fixed this session:**

1. **Preflight response has NO quality data — corrected from the previous
   optimistic shape.** The real `ApprovalService.preflight()` response is
   exactly `{ requiresApproval, approvalPolicy, isStale }` — it does **not**
   include `blockers[]`/`recommendations[]`/context-conflict data. Those
   fields live entirely in the separate `document-agent/quality` endpoint
   (§9) and are **not wired into `/delivery/preflight` at all**. A frontend
   that renders "✓ Passed" from a 200 response without also checking the
   quality endpoint's `blockers`/`readiness` would be lying about readiness.
   Corrected the request-fields row above (removed the invented
   `PREFLIGHT_FAILED` 422 — no such error code exists in source).
2. **Frozen-snapshot bug, fixed this session.** A share link pinned to a
   `versionId` was stored correctly, but `ShareLinkService.getByToken` never
   read the version snapshot — it always served the LIVE, possibly
   since-edited `draft.config`. Editing a draft after sharing silently
   changed what an already-distributed public link showed, defeating the
   entire point of pinning a version before sharing. **Fixed**: `getByToken`
   now loads `WsDocVersion.snapshot` when `link.versionId` is set and serves
   the frozen `docTitle`/`sections` from it. The frontend's share-creation
   flow (`WorkspaceEditorStabilized.tsx` `onCreateShare`) already did the
   correct thing (creates a version snapshot, then passes its `versionId`)
   — this was purely a backend gap.
3. **Guest comments, fixed this session (was GAPS.md §13, now CLOSED).**
   Previously a pure echo (`{ ok: true, text }`, no persistence, no
   `WsGuestComment` model, rate-limit rejection returned 200 with an
   `{error}` field instead of a real 429). **Fixed**: added a `WsGuestComment`
   Prisma model + migration (`20260815000000_ws_guest_comment`), wired
   `addGuestComment` to persist `{tenantId, draftId, shareLinkId, body,
   guestName}`, added `@MaxLength(2000)`/`@MaxLength(200)` validation
   (previously declared-but-unenforced), and the rate-limit path now throws a
   real `HttpException(429)`. Added an authenticated
   `GET .../delivery/guest-comments` so the internal team can actually see
   guest feedback — this endpoint is new; **no frontend panel was built to
   render it this session** (out of scope for the audit's time budget) —
   logged as a remaining frontend gap in GAPS.md.

## 11. Template Studio

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| GET | `/template-studio/blueprints` | — | `{ blueprints: BlueprintSummary[] }` | — | Studio: blueprint list |
| POST | `/template-studio/blueprints` | blueprint data | `BlueprintSummary` | — | Studio: New blueprint |
| GET | `/template-studio/blueprints/:blueprintId` | — | blueprint + versions | — | Studio: blueprint detail |
| POST | `/template-studio/blueprints/:blueprintId/clone` | clone data | `BlueprintVersion` | — | Studio: Clone |
| POST | `/template-studio/blueprints/:blueprintId/versions` | version data | `BlueprintVersion` | — | Studio: New draft version |
| GET | `/template-studio/blueprints/:blueprintId/versions/:versionId` | — | `BlueprintVersion` | — | Studio: version detail |
| PATCH | `/template-studio/blueprints/:blueprintId/versions/:versionId` | update data | `BlueprintVersion` | 409 `BLUEPRINT_IMMUTABLE` | Studio: edit version |
| POST | `/template-studio/blueprints/:blueprintId/versions/:versionId/test` | test data | test result | — | Studio: Test run |
| POST | `/template-studio/blueprints/:blueprintId/versions/:versionId/publish` | — | `BlueprintVersion` | — | Studio: Publish |
| POST | `/template-studio/blueprints/:blueprintId/versions/:versionId/retire` | — | `BlueprintVersion` | — | Studio: Retire |
| GET | `/template-studio/blueprints/:blueprintId/compare` | — | comparison data | — | Studio: Compare |

## 12. Document Plumbing (existing, reused)

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| GET | `/drafts?scope=&sector=` | — | `{ drafts: DraftSummary[] }` | — | Library |
| GET | `/drafts/:draftId` | — | `Draft` | 404 | Editor |
| POST | `/drafts` | `{ docTitle?, sector? }` | `{ id }` | — | Creation flow |
| DELETE | `/drafts/:draftId` | — | — | — | Editor: delete |
| GET | `/drafts/:draftId/documents` | — | `{ documents: DraftDocument[] }` (tenant-scoped only, no per-object ACL) | — | Canvas: packet tabs |
| POST | `/drafts/:draftId/documents` | `{ name!, ordinal?, body? }` | `DraftDocument` | — | Canvas: add tab |
| PATCH | `/drafts/:draftId/documents/:docId` | `{ name?, ordinal?, body? }` | `DraftDocument` | — | Canvas: autosave |
| DELETE | `/drafts/:draftId/documents/:docId` | — | — | — | Canvas: remove tab |
| GET | `/documents/:documentId/comments` | — | `{ comments: WorkspaceComment[] }` (tenant-scoped only, no role check) | — | Comments drawer |
| POST | `/documents/:documentId/comments` | `{ body!, quote?, anchor?, parentId?, role? }` | `WorkspaceComment` | 403 (viewer) | Comments drawer |
| PATCH | `/documents/:documentId/comments/:commentId` | `{ body?, resolved? }` | `WorkspaceComment` | 403 (not canReview) | Comments drawer |
| DELETE | `/documents/:documentId/comments/:commentId` | — | `{ deleted: true }` | 403 | Comments drawer |
| POST | `/documents/:documentId/comments/:commentId/suggest` | — | before/after suggestion | 400 (no quote), 403 (not canReview) | Comments: suggest edit |
| GET | `/drafts/:draftId/collaborators` | — | `{ collaborators: Collaborator[] }` (incl. synthetic owner row `id:'owner:<draftId>'`) | — | Collab overlay |
| POST | `/drafts/:draftId/collaborators` | `{ subjectId?, email?, name?, role!: editor\|reviewer\|commenter\|viewer, inviterName? }` | `Collaborator` | 403 (not owner) | Collab overlay |
| PATCH | `/drafts/:draftId/collaborators/:id` | `{ role! }` | `Collaborator` | 403 (not owner) | Collab overlay |
| DELETE | `/drafts/:draftId/collaborators/:id` | — | — | 403 (not owner) | Collab overlay |
| GET | `/drafts/:draftId/versions` | — | `{ versions: DraftVersion[] }` | — | Versions overlay |
| POST | `/drafts/:draftId/versions` | `{ label?, authorKind?: 'meri'\|'person' }` | `DraftVersion` (full config + document-body snapshot) | — | Versions overlay |
| POST | `/drafts/:draftId/versions/:versionId/restore` | — | full updated `Draft` (does NOT itself create a new version) | — | Versions overlay |
| GET | `/drafts/:draftId/lock` | — | `{ held, heldByMe, holderId, holderName, acquiredAt, lastHeartbeatAt, holderInactive, requestedById, requestedByName, requestedAt, hasIncomingRequest }` | — | Lock banner |
| POST | `/drafts/:draftId/lock/acquire` | — | `LockStatus` | 403 (not canEdit) | Lock |
| POST | `/drafts/:draftId/lock/heartbeat` | — | — | — | Lock heartbeat |
| POST | `/drafts/:draftId/lock/release` | — | — | — | Lock release |
| POST | `/drafts/:draftId/lock/request` | — | — | — (no role gate — any tenant member) | Lock: request access |
| POST | `/drafts/:draftId/lock/take-over` | — | `LockStatus` | 403 (holder still active, not canEdit) | Lock: stale takeover |
| GET | `/drafts/:draftId/export/docx?part=` | — | binary | — | Export overlay |
| GET | `/drafts/:draftId/export/pdf?part=` | — | binary | — | Export overlay |
| POST | `/drafts/:draftId/anonymize/detect` | — | candidates | — | Anonymize overlay |
| POST | `/drafts/:draftId/promote-memory` | — | — | — | More menu |

**RE-VERIFIED 2026-08-15 — corrections to the rows above:**

- **Document body field is `name`, not `title`**, and `body` is a structured
  JSON blocks object (`WsDocument.body: Json`), never an HTML string. No
  `{title, body: htmlString}` shape exists anywhere in this module or schema.
  The previous inventory row was wrong; corrected above.
- **Comment field is `body`, not `text`** — confirmed in both the DTO
  (`CreateCommentDto.body`) and the Prisma model. The routed
  `WorkspaceEditorStabilized.tsx` already uses the canonical `body`-based
  hooks from the legacy `pages/workspace/api.ts` — no defect there. The
  *unrouted* prototype `editor/WorkspaceEditorVNext.tsx` and its private
  `types/agent.ts` (`WorkspaceComment.text`, a 4-role `Collaborator` missing
  `commenter`, and a `heldBy: 'me'` sentinel-string `EditLock` shape) reinvent
  a non-canonical contract — this code is unreachable from routing (confirmed
  no import path reaches it) but is a landmine for a future "quick fix" that
  resurrects it. Recommend deleting it in a follow-up (not done this session
  — flagged, not silently left implying it's fine).
- **Comment delete had NO collaborator ACL check at all — fixed this
  session.** `CommentsService.remove()` only scoped by tenantId, no
  `collaborators.assertCan` call — any tenant member could delete any comment
  on any draft. **Fixed**: deleting another person's comment now requires
  `canReview` (owner/editor/reviewer); an author may always delete their own
  comment (gated on `canComment`, i.e. must still have access at all).
  Regression tests added in `src/comments/comments.service.spec.ts`.
- **Edit-lock fields confirmed real, not a placeholder.** `holderId` is a
  real Clerk user id the frontend would have to compare itself — but the
  canonical legacy hook (`useEditLock.ts`) never does that; it trusts the
  server-computed `heldByMe` boolean directly, and so does the routed vNext
  editor (`editLock.lock.held && !editLock.lock.heldByMe`). Stale-takeover
  eligibility (`holderInactive`) is server-computed (10-minute inactivity
  window) and re-verified server-side inside `takeOver` itself. No client-side
  lock-age computation exists or is needed.
- **Lock ACL asymmetry, not fixed (flagging only):** `acquire`/`takeOver`
  require `canEdit`; `status`/`heartbeat`/`release`/`request` have no role
  gate beyond tenant scope — in particular `request()` lets any tenant
  member (not necessarily a collaborator on this specific draft) register a
  request against the holder. Not fixed this session (lower severity, no
  live UI path was found that depends on tightening it); logged in GAPS.md.

## 13. Document Themes — **NO ROUTES**

No theme CRUD routes exist. See GAPS.md §15–17. The theme editor is read-only.
