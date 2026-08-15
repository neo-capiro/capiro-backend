# Workspace vNext API Inventory

> Source of truth for the Workspace Document Agent vNext frontend. One row per
> endpoint from PR #922 (`agent/workspace-document-agent-backend-vnext`, SHA
> `33c362672246b62e22dfad9757c0f4988f95963a`), verified against the backend
> controller and DTO code. All routes are under `/workspace-api`.

## Status

- **PR #922**: OPEN (not merged to main as of 2026-08-12). Backend branch
  `agent/workspace-document-agent-backend-vnext` at SHA
  `33c362672246b62e22dfad9757c0f4988f95963a`.
- **Feature flag**: `WORKSPACE_DOCUMENT_AGENT_VNEXT_ENABLED` (env, default
  `false`). Per-tenant via `tenants.settings_jsonb`.
- **MERIV3_ORCHESTRATOR_URL**: Required for reasoning routes. Without it,
  reasoning routes return 503.

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
| PATCH | `/drafts/:draftId/agent` | `{ expectedRevision, documentType?, blueprintPin?, theme?, goal?, phase?, status? }` | `{ state: AgentState }` | 409 `DOCUMENT_AGENT_REVISION_CONFLICT` | Editor: mode chip, phase transitions |

**Note**: `PATCH /agent` DTO accepts `documentType`, `blueprintPin`, `theme`,
`goal`, `phase`, `status` but does NOT explicitly accept `generation.mode`.
Generation mode persistence is **unconfirmed** — see GAPS.md §2.

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
| PATCH | `/drafts/:draftId/context/:itemId` | `{ payload: Record }` | updated item | — | Context tab: item metadata |
| GET | `/drafts/:draftId/context` | — | `{ items: ContextItem[] }` | — | Context tab: item list |
| POST | `/drafts/:draftId/context` | item data | created item | — | Agent panel: + attach |
| DELETE | `/drafts/:draftId/context/:itemId` | — | — | — | Context tab: remove |
| GET | `/drafts/:draftId/context-used` | — | used context | — | Canvas: Context used link |

**Gap**: No semantic conflict-resolution route. See GAPS.md §4.

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

**Gap**: Proposal payload shape is unspecified. See GAPS.md §10.

## 8. Generation

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| POST | `/drafts/:draftId/agent/generate` | `{ expectedRevision, mode?, idempotencyKey? }` | `{ state: AgentState }` | 409, 422 | Canvas: Start generation |
| GET | `/drafts/:draftId/agent/generation` | — | `{ runId, mode, status, startedAt, completedAt?, stages[], sectionResults? }` | — | Canvas: poll status |
| POST | `/drafts/:draftId/agent/generation/retry` | `{ expectedRevision, sectionIds? }` | `{ state: AgentState }` | 409 | Canvas: Retry failed |
| POST | `/drafts/:draftId/agent/generation/cancel` | `{ expectedRevision }` | `{ state: AgentState }` | 409 | Canvas: Cancel |

## 9. Quality

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| GET | `/drafts/:draftId/agent/quality` | — | `{ score, readiness, blockers[], recommendations[], checks[] }` | — | Quality tab |
| POST | `/drafts/:draftId/agent/quality/issues/:issueId/fix` | `{ expectedRevision, instruction? }` | `{ proposalId }` | 409, 503 | Quality tab: Fix with Meri |

## 10. Delivery, Approval & Share

| Method | Path | Request Fields | Response Fields | Errors | UI Surface |
|---|---|---|---|---|---|
| POST | `/drafts/:draftId/delivery/preflight` | — | `{ requiresApproval, approvalPolicy, isStale }` | 422 `PREFLIGHT_FAILED` | Delivery overlay |
| POST | `/drafts/:draftId/delivery/approval-requests` | `{ versionId?, notes?, idempotencyKey? }` | approval request | 409 (pending) | Delivery overlay |
| POST | `/drafts/:draftId/delivery/approval-requests/:requestId/decision` | `{ decision, note? }` | — | — | Delivery overlay |
| POST | `/drafts/:draftId/delivery/share-links` | `{ label?, expiresInDays?, versionId?, idempotencyKey? }` | `{ shareId, token, expiresAt }` | — | Delivery overlay: Create share |
| DELETE | `/drafts/:draftId/delivery/share-links/:shareLinkId` | — | — | — | Delivery overlay: Revoke |
| GET | `/public/workspace-share/:token` | — | sanitized document payload | 404 (expired/revoked/unknown) | Public share route |
| POST | `/public/workspace-share/:token/comments` | `{ text, name? }` | — | 429 (rate limited) | Public share: guest comment |

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
| GET | `/drafts/:draftId/documents` | — | `{ documents: DraftDocument[] }` | — | Canvas: packet tabs |
| POST | `/drafts/:draftId/documents` | `{ title }` | `DraftDocument` | — | Canvas: add tab |
| PATCH | `/drafts/:draftId/documents/:docId` | `{ title?, body? }` | `DraftDocument` | — | Canvas: autosave |
| DELETE | `/drafts/:draftId/documents/:docId` | — | — | — | Canvas: remove tab |
| GET | `/documents/:documentId/comments` | — | `{ comments: WorkspaceComment[] }` | — | Comments drawer |
| POST | `/documents/:documentId/comments` | `{ text, parentId? }` | `WorkspaceComment` | — | Comments drawer |
| PATCH | `/documents/:documentId/comments/:commentId` | `{ resolved?, text? }` | `WorkspaceComment` | — | Comments drawer |
| DELETE | `/documents/:documentId/comments/:commentId` | — | — | — | Comments drawer |
| POST | `/documents/:documentId/comments/:commentId/suggest` | — | — | — | Comments: suggest edit |
| GET | `/drafts/:draftId/collaborators` | — | `{ collaborators: Collaborator[] }` | — | Collab overlay |
| POST | `/drafts/:draftId/collaborators` | `{ email, role }` | `Collaborator` | — | Collab overlay |
| PATCH | `/drafts/:draftId/collaborators/:id` | `{ role? }` | `Collaborator` | — | Collab overlay |
| DELETE | `/drafts/:draftId/collaborators/:id` | — | — | — | Collab overlay |
| GET | `/drafts/:draftId/versions` | — | `{ versions: DraftVersion[] }` | — | Versions overlay |
| POST | `/drafts/:draftId/versions` | `{ label? }` | `DraftVersion` | — | Versions overlay |
| POST | `/drafts/:draftId/versions/:versionId/restore` | — | — | — | Versions overlay |
| GET | `/drafts/:draftId/lock` | — | `EditLock` | — | Lock banner |
| POST | `/drafts/:draftId/lock/acquire` | — | `EditLock` | — | Lock |
| POST | `/drafts/:draftId/lock/heartbeat` | — | — | — | Lock heartbeat |
| POST | `/drafts/:draftId/lock/release` | — | — | — | Lock release |
| POST | `/drafts/:draftId/lock/request` | — | — | — | Lock: request access |
| POST | `/drafts/:draftId/lock/take-over` | — | `EditLock` | — | Lock: stale takeover |
| GET | `/drafts/:draftId/export/docx?part=` | — | binary | — | Export overlay |
| GET | `/drafts/:draftId/export/pdf?part=` | — | binary | — | Export overlay |
| POST | `/drafts/:draftId/anonymize/detect` | — | candidates | — | Anonymize overlay |
| POST | `/drafts/:draftId/promote-memory` | — | — | — | More menu |

## 13. Document Themes — **NO ROUTES**

No theme CRUD routes exist. See GAPS.md §15–17. The theme editor is read-only.
