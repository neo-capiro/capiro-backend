# Workspace Document Agent API Contract

> Backend contract for the Workspace Document Agent vNext — the conversational
> document-generation experience. The frontend is implemented separately; this
> document is the complete contract.

## Feature Flag

**`WORKSPACE_DOCUMENT_AGENT_VNEXT_ENABLED`** (env, default `false`)

When `false`, the new controllers are registered but the service-level
behavior degrades gracefully — existing routes remain unaffected. Enable
per-tenant via the existing tenant-settings mechanism (`tenants.settings_jsonb`).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WORKSPACE_DOCUMENT_AGENT_VNEXT_ENABLED` | `false` | Feature flag for the new experience |
| `MERIV3_ORCHESTRATOR_URL` | (none) | Base URL of the MeriV3 reasoning orchestrator |
| `WORKSPACE_REASONING_TIMEOUT_MS` | `180000` | Timeout for reasoning gateway calls |
| `MERIV3_MODEL` | `gpt-5.6-terra` | Standard reasoning model (server-configured) |
| `MERIV3_DEEP_MODEL` | `gpt-5.6` | Deep/high reasoning model |
| `MERIV3_MAX_MODEL` | (deep model) | Max reasoning model |

## API Prefix

All routes are under the existing `/workspace-api` prefix.

---

## 1. Catalog & Recommendation

### GET `/document-agent/catalog`

Returns the document type catalog (derived from existing templates).

**Response:**
```json
{
  "documentTypes": [
    { "id": "uuid", "label": "NDAA Paper", "product": "NDAA" }
  ]
}
```

### POST `/document-agent/recommend`

Recommends a document setup (type, blueprint, theme, questions) from a goal.

**Request:**
```json
{
  "goal": "Build a two-page NDAA paper asking HASC to protect autonomous ground systems funding.",
  "client": "Overland AI"
}
```

**Response:**
```json
{
  "documentType": { "id": "ndaa", "label": "NDAA Paper", "product": "NDAA" },
  "recommendedBlueprints": [
    { "blueprintId": "uuid", "name": "Defense Advocacy Brief", "slug": "defense-advocacy" }
  ],
  "recommendedTheme": { "id": "default", "name": "Default Formal" },
  "questions": [
    { "id": "q1", "label": "Which committees are you targeting?", "required": true }
  ],
  "rationale": "NDAA papers targeting HASC funding protection require..."
}
```

**Never** returns or persists model chain-of-thought.

---

## 2. Draft Agent State

### GET `/drafts/:draftId/agent`

Returns the current agent state.

**Response:**
```json
{
  "state": {
    "schemaVersion": 1,
    "revision": 5,
    "phase": "brief",
    "status": "ready",
    "documentType": { "id": "ndaa", "label": "NDAA Paper", "product": "NDAA" },
    "blueprintPin": { "blueprintId": "uuid", "versionId": "uuid", "version": 2, "definitionHash": "sha256..." },
    "theme": { "id": "default", "name": "Default", "settings": {} },
    "goal": { "text": "...", "client": "Overland AI", "createdAt": "2026-08-12T..." },
    "brief": { "objective": "...", "assumptions": [], "provenance": {}, "approvedAt": null },
    "contextPlan": { "includedItemIds": [], "excludedItems": [], "conflicts": [], "coverage": { ... } },
    "outline": { "version": 1, "sections": [] },
    "generation": { "mode": "standard" }
  }
}
```

### POST `/drafts/:draftId/agent/initialize`

Initializes agent state on a draft. Idempotent — returns existing state if already initialized.

**Request:**
```json
{
  "documentType": { "id": "ndaa", "label": "NDAA Paper", "product": "NDAA" },
  "blueprintPin": { "blueprintId": "uuid", "versionId": "uuid", "version": 2, "definitionHash": "sha256..." },
  "theme": { "id": "default", "name": "Default", "settings": {} },
  "goal": "Build a two-page NDAA paper..."
}
```

### PATCH `/drafts/:draftId/agent`

General state mutation with optimistic concurrency. Every mutation accepts `expectedRevision`.

**Request:**
```json
{
  "expectedRevision": 4,
  "documentType": { "id": "ndaa", "label": "NDAA Paper", "product": "NDAA" },
  "phase": "blueprint"
}
```

**409 Conflict** (stale revision):
```json
{
  "statusCode": 409,
  "message": "DOCUMENT_AGENT_REVISION_CONFLICT",
  "code": "DOCUMENT_AGENT_REVISION_CONFLICT"
}
```

---

## 3. Conversation

### GET `/drafts/:draftId/agent/messages`

Returns conversation messages (append-only, ordered by createdAt).

### POST `/drafts/:draftId/agent/messages`

Send a message. Idempotent via `idempotencyKey`.

**Request:**
```json
{
  "text": "I need this to convince HASC staff to protect the full FY27 request.",
  "phase": "brief",
  "expectedRevision": 4,
  "idempotencyKey": "client-generated-uuid",
  "scope": { "kind": "whole_document" }
}
```

**Selected-text revision scope:**
```json
{
  "scope": {
    "kind": "selection",
    "documentId": "uuid",
    "sectionId": "funding-position",
    "quote": "Selected passage",
    "start": 410,
    "end": 544
  }
}
```

**Response:**
```json
{
  "message": "I have enough to create the working brief.",
  "phase": "brief",
  "revision": 5,
  "questions": [],
  "stateSummary": { ... },
  "proposal": null,
  "allowedActions": ["review_brief", "edit_brief"]
}
```

The agent asks only questions that materially improve the document. Grouped into one turn.

---

## 4. Brief

### PUT `/drafts/:draftId/agent/brief`

Update the brief fields. Requires `expectedRevision`.

### POST `/drafts/:draftId/agent/brief/synthesize`

Synthesize the brief from the conversation. Provenance for every material field:
`user` | `retrieved` | `suggested` | `assumed`. Assumptions remain visible until confirmed/rejected.

### POST `/drafts/:draftId/agent/brief/approve`

Approve the brief. Transitions to `context` phase.

### POST `/drafts/:draftId/agent/brief/reopen`

Reopen the brief. Clears `approvedAt` and returns to `brief` phase.

---

## 5. Context

### POST `/drafts/:draftId/agent/context/recommend`

Recommend which context items to include/exclude.

### POST `/drafts/:draftId/agent/context/analyze`

Analyze context for conflicts and coverage. Produces:

**ContextCoverage:**
```json
{
  "plannedClaims": 10,
  "supportedClaims": 7,
  "missingClaims": [
    { "claimId": "c3", "description": "FY27 authorization level", "recommendedSourceTypes": ["government"] }
  ]
}
```

**ContextConflict:**
```json
{
  "id": "numeric:funding",
  "itemIds": ["item-1", "item-2"],
  "type": "numeric",
  "description": "Items disagree on \"Funding\": 100, 200",
  "recommendedResolution": "Verify the authoritative source.",
  "resolved": false,
  "resolution": null
}
```

Conflicts are never silently resolved. The user must approve the resolution.

### POST `/drafts/:draftId/agent/context/approve`

Approve the context plan. Transitions to `outline` phase.

### PATCH `/drafts/:draftId/context/:itemId`

Extends `WsContextItem.payload` (not replacing the model):

```json
{
  "label": "Updated label",
  "sourceType": "government",
  "authority": "primary",
  "freshness": "current",
  "included": true
}
```

---

## 6. Outline

### POST `/drafts/:draftId/agent/outline/generate`

Generate the outline from the pinned blueprint. Each section has a stable ID:

```json
{
  "id": "section-funding-position",
  "title": "Funding Position",
  "purpose": "State the funding ask and justification.",
  "instructions": "Cite the PB line and delta.",
  "required": true,
  "locked": false,
  "targetWords": { "min": 200, "max": 400 },
  "evidenceItemIds": ["item-1", "item-2"]
}
```

### PUT `/drafts/:draftId/agent/outline`

Update the outline sections.

### POST `/drafts/:draftId/agent/outline/revise`

Revise the outline. Creates a `WsAgentProposal` (does NOT mutate the outline directly). Returns before/after diff.

### POST `/drafts/:draftId/agent/outline/approve`

Approve the outline. Transitions to `generate` phase.

---

## 7. Revision Proposals

### GET `/drafts/:draftId/agent/proposals`

List proposals.

### POST `/drafts/:draftId/agent/proposals/:proposalId/accept`

Accept a proposal. Before applying:
1. Compare `baseRevision`.
2. Recompute the affected-content hash.
3. Compare with `baseHash`.
4. Return **409 `PROPOSAL_STALE`** if the document changed.

### POST `/drafts/:draftId/agent/proposals/:proposalId/reject`

Reject a proposal.

---

## 8. Generation

### POST `/drafts/:draftId/agent/generate`

Start generation. Modes: `quick`, `standard`, `max`.

**Request:**
```json
{
  "expectedRevision": 10,
  "mode": "max",
  "idempotencyKey": "uuid"
}
```

For `mode=max`, the pipeline is:
1. `preflight` — validate and freeze brief, context snapshot, outline, blueprint.
2. `evidence_plan` — produce a structured evidence plan.
3. `narrative_plan` — produce one global narrative plan.
4. `drafting` — draft sections against the same context and narrative plan.
5. `editorial_pass` — global editorial pass.
6. `assurance` — run existing citation, grounding, assurance logic.
7. `snapshot` — persist only verified/released content. Create "As generated" snapshot.
8. `complete` — mark run complete/complete_with_warnings/partial/failed.

Extends the existing `GenerationService` (does not bypass it).

### GET `/drafts/:draftId/agent/generation`

Poll generation status. Returns the run summary with stages.

### POST `/drafts/:draftId/agent/generation/retry`

Retry failed sections. Does NOT regenerate successful sections. Preserves prior content; marks failed sections stale.

### POST `/drafts/:draftId/agent/generation/cancel`

Cancel generation. Marks status as `partial`.

---

## 9. Quality

### GET `/drafts/:draftId/agent/quality`

Returns quality evaluation (adapter over existing `ChecksService` + agent-specific checks).

**Response:**
```json
{
  "score": 96,
  "readiness": "ready_with_recommendations",
  "blockers": [],
  "recommendations": ["Open assumptions: 2 open"],
  "checks": [
    {
      "id": "agent:brief_approved",
      "label": "Working brief approved",
      "status": "success",
      "detail": "approved",
      "fixable": false,
      "severity": "low"
    }
  ]
}
```

Agent-specific checks:
- brief approved
- context approved
- outline approved
- blueprint version pinned
- required sections present
- locked sections preserved
- claim coverage
- citation coverage
- open assumptions
- unresolved source conflicts
- stale verification
- generation partial/failed state
- client-facing approval requirement

### POST `/drafts/:draftId/agent/quality/issues/:issueId/fix`

Creates a revision proposal (does NOT silently edit).

---

## 10. Template Studio

### GET `/template-studio/blueprints`

List blueprints (capiro global + firm tenant).

### POST `/template-studio/blueprints`

Create a blueprint (firm admin only).

### GET `/template-studio/blueprints/:blueprintId`

Get one blueprint.

### POST `/template-studio/blueprints/:blueprintId/clone`

Clone a blueprint into a new draft version.

### POST `/template-studio/blueprints/:blueprintId/versions`

Create a new draft version.

### GET `/template-studio/blueprints/:blueprintId/versions/:versionId`

Get a version.

### PATCH `/template-studio/blueprints/:blueprintId/versions/:versionId`

Update a draft version. **409** if published (immutable).

### POST `/template-studio/blueprints/:blueprintId/versions/:versionId/test`

Test a draft version (deterministic simulated intake + outline; no permanent document).

### POST `/template-studio/blueprints/:blueprintId/versions/:versionId/publish`

Publish a version. Requirements:
- Definition passes schema validation.
- Required fields complete.
- Every required section has purpose and instructions.
- Evidence policy exists.
- Sample test passes.
- Version is currently `draft`.
- Definition hash saved.
- Published row becomes **immutable**.

### POST `/template-studio/blueprints/:blueprintId/versions/:versionId/retire`

Retire a published version.

### GET `/template-studio/blueprints/:blueprintId/compare`

Compare versions.

**Version pinning:** Existing documents remain pinned to their original blueprint version and definition hash. A new version never applies retroactively.

---

## 11. Delivery, Approval & Share Links

### POST `/drafts/:draftId/delivery/preflight`

Client-facing delivery preflight. Checks the pinned blueprint's `approvalPolicy.clientFacingApprovalRequired`.

**Response:**
```json
{
  "requiresApproval": true,
  "approvalPolicy": { "clientFacingApprovalRequired": true, "permittedApproverRoles": ["owner", "reviewer"] },
  "isStale": false
}
```

**422** on preflight failure.

### POST `/drafts/:draftId/delivery/approval-requests`

Create an approval request. **409** if already pending. Idempotency key supported.

### POST `/drafts/:draftId/delivery/approval-requests/:requestId/decision`

Decide on an approval request. Only owner/reviewer can decide.

A document changed after approval becomes **approval-stale**.

### POST `/drafts/:draftId/delivery/share-links`

Create a share link. Returns the token **once**; only the hash is stored.

**Response:**
```json
{
  "shareId": "uuid",
  "token": "random-32-byte-hex",
  "expiresAt": "2026-08-19T..."
}
```

### DELETE `/drafts/:draftId/delivery/share-links/:shareLinkId`

Revoke a share link (sets `revokedAt`).

### GET `/public/workspace-share/:token`

**Public** (no auth). Returns a sanitized document payload:
- **No** tenant IDs
- **No** internal context packets
- **No** memory files
- **No** internal comments
- **No** private source text
- **No** model prompts
- **No** provider errors

**404** if not found, expired, or revoked.

### POST `/public/workspace-share/:token/comments`

**Public** guest comment. Rate limited (10 comments / 5 minutes / token). Sanitized text (HTML stripped, max 2000 chars).

---

## 12. Error Codes

| Code | HTTP | Description |
|---|---|---|
| `DOCUMENT_AGENT_REVISION_CONFLICT` | 409 | Stale revision on mutation |
| `PROPOSAL_STALE` | 409 | Document changed since proposal was created |
| `BLUEPRINT_IMMUTABLE` | 409 | Attempted to modify a published blueprint version |
| `PREFLIGHT_FAILED` | 422 | Generation or delivery preflight failure |
| `REASONING_UNAVAILABLE` | 503 | Reasoning infrastructure unavailable |

---

## 13. State Machine Transitions

```
type → blueprint → design → goal → brief → context → outline → generate → draft → quality → complete
```

Backward transitions allowed to: `type`, `blueprint`, `design`, `goal`, `brief`, `context`, `outline`.
Not directly reopenable: `generate`, `draft`, `quality` (re-triggered via endpoints).

Status: `active` | `needs_input` | `ready` | `generating` | `partial` | `failed` | `complete`

---

## 14. End-to-End Request Sequence

```
1. POST /document-agent/recommend
   → { documentType, recommendedBlueprints, questions, rationale }

2. POST /drafts/:draftId/agent/initialize
   → { state: { revision: 1, phase: "blueprint" } }

3. POST /drafts/:draftId/agent/messages
   → { message, questions, revision, allowedActions }

4. POST /drafts/:draftId/agent/brief/synthesize
   → { state: { brief: { objective, assumptions, provenance, status: "ready" } } }

5. POST /drafts/:draftId/agent/brief/approve
   → { state: { phase: "context" } }

6. POST /drafts/:draftId/agent/context/recommend
   → { recommendations: { includedItemIds, excludedItems } }

7. POST /drafts/:draftId/agent/context/analyze
   → { state: { contextPlan: { conflicts, coverage, snapshotHash } } }

8. POST /drafts/:draftId/agent/context/approve
   → { state: { phase: "outline" } }

9. POST /drafts/:draftId/agent/outline/generate
   → { state: { outline: { sections } } }

10. POST /drafts/:draftId/agent/outline/approve
    → { state: { phase: "generate" } }

11. POST /drafts/:draftId/agent/generate { mode: "max" }
    → { state: { generation: { lastRun: { status: "complete" } } } }

12. GET /drafts/:draftId/agent/quality
    → { score: 96, readiness: "ready_with_recommendations" }

13. POST /drafts/:draftId/delivery/preflight
    → { requiresApproval: true }

14. POST /drafts/:draftId/delivery/approval-requests
    → { approvalRequest: { id, status: "pending" } }

15. POST /drafts/:draftId/delivery/approval-requests/:id/decision
    → { status: "approved" }

16. POST /drafts/:draftId/delivery/share-links
    → { shareId, token, expiresAt }

17. GET /public/workspace-share/:token
    → { docTitle, sections: [...], sanitized: true }
```
