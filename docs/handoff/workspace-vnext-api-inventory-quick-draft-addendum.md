# Workspace vNext API Inventory — Quick-Draft Addendum

This addendum covers the simplified two-screen creation flow introduced after the original Workspace vNext inventory.

## `POST /workspace-api/drafts/:draftId/agent/generate-from-intake`

### Purpose

Convert a fully initialized draft plus one intake packet into a complete editable first draft using the existing structured Max reasoning gateway.

### Authentication and authorization

- `TenantGuard`
- current tenant from `@CurrentTenant()`
- object-level `canEdit` collaborator policy
- browser request is sent through the existing Clerk-aware Workspace transport bridge

The browser does not send `tenantId`, `ownerId`, or an acting user ID.

### Request

```ts
interface GenerateFromIntakeRequest {
  expectedRevision: number;
  goal: string; // max 10,000 chars
  sources: Array<{
    purpose: 'context' | 'client_saved' | 'sample' | 'system';
    label: string;
    text?: string; // max 50,000 chars
    refId?: string;
    url?: string;
    sourceType?: string;
    metadata?: Record<string, unknown>;
  }>;
}
```

Maximum 40 sources.

### Source semantics

| Purpose | Factual use | Meaning |
| --- | --- | --- |
| `context` | Yes | User-supplied factual/background material, including the resolved client profile |
| `client_saved` | Yes | Existing Workspace documents selected from the client’s saved work |
| `sample` | No | Style, structure, organization and rhetorical-quality reference only |
| `system` | No until resolved | Requested Capiro context domain; a checkbox/instruction cannot itself support a claim |

### Processing

1. Verify the latest `expectedRevision`.
2. Verify the pinned blueprint version is still published and tenant-visible.
3. Deduplicate and persist selected sources as `WsContextItem` records.
4. Synthesize and approve a Working Brief.
5. Analyze factual context conflicts and claim coverage.
6. Generate and approve an outline against the pinned blueprint.
7. Run Max document planning.
8. Draft all sections using the global plan.
9. Run a whole-document Max editorial pass.
10. Sanitize and atomically persist `config.sections`, `config.sectionContent`, the intake snapshot, and the updated Agent state.
11. Best-effort append the goal and ready message to the Agent transcript.

### Response

```ts
interface GenerateFromIntakeResponse {
  state: DocumentAgentState;
  run: DocumentAgentRunSummary;
  draft: {
    id: string;
    docTitle: string;
  };
  sourceSummary: {
    total: number;
    factual: number;
    samples: number;
    system: number;
  };
}
```

On success the state is in `phase: 'draft'`, with `generation.mode: 'max'`.

### Concurrency

Two checks protect the final write:

- Agent `expectedRevision` at request start.
- `WsDraft.updatedAt` comparison on the final atomic save.

Conflict response:

```text
409 DOCUMENT_AGENT_REVISION_CONFLICT
```

The frontend preserves the initialized draft and offers a recovery path rather than blindly retrying.

### Conflict behavior

Context conflicts do not disappear to simplify the flow.

When conflicts exist:

- draft generation may finish with qualified or omitted claims;
- run status is `complete_with_warnings`;
- conflicts remain `resolved=false`;
- context is not marked approved;
- existing quality and delivery gates remain responsible for blocking client-facing delivery.

### Failure behavior

If the reasoning pipeline fails before the final save:

- the initialized draft and attached intake sources remain available;
- Agent state records a failed Max run where the optimistic draft lock still permits it;
- the frontend offers **Open saved draft**.

If Agent transcript insertion fails after the document is saved, the endpoint still returns the successfully persisted draft.

### Current infrastructure limitations

- The endpoint is request-scoped rather than a durable queued job.
- Direct PDF/DOCX binary parsing is not exposed on this intake yet.
- The client profile is resolved; other selected Capiro domains remain non-factual retrieval requests pending a unified cross-service context resolver.
