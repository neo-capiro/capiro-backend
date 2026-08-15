# Workspace Two-Screen Flow — Acceptance Test Plan

## Setup

- Workspace backend includes this branch.
- `WORKSPACE_DOCUMENT_AGENT_VNEXT_ENABLED=true` for the dev tenant.
- `MERIV3_ORCHESTRATOR_URL` is configured and reachable.
- At least one published Capiro blueprint and one published firm blueprint exist.
- A test client has an existing Workspace document.

## Flow A — minimal goal

1. Open `/workspace/new`.
2. Enter a goal.
3. Choose a published template.
4. Generate without optional documents.
5. Verify one draft is created and the browser opens `/workspace/:draftId`.
6. Verify the paper contains generated editable sections.
7. Verify Meri transcript contains the goal and ready response.

## Flow B — all source groups

1. Choose a client.
2. Add relevant text or a supported text-readable file.
3. Select a saved Workspace document for that client.
4. Add a sample document.
5. Select multiple Capiro context domains.
6. Generate.
7. Verify Context shows the sources with their distinct purpose/use policies.
8. Verify sample and unresolved system request IDs are absent from outline evidence IDs.

## Flow C — context conflict

1. Add two factual sources with contradictory amounts or dates.
2. Generate.
3. Verify the first draft is available.
4. Verify run status is `complete_with_warnings`.
5. Verify the conflict is visible and unresolved.
6. Verify context is not approved and delivery is blocked.

## Flow D — concurrent edit protection

1. Start a Max generation request.
2. Modify the same draft from another authorized session before the final save.
3. Verify the generation request returns `409 DOCUMENT_AGENT_REVISION_CONFLICT`.
4. Verify the human edit remains intact.

## Flow E — failure recovery

1. Force the reasoning gateway to fail after initialization.
2. Verify the initialized draft remains accessible.
3. Verify the UI offers **Open saved draft**.
4. Verify a failed Max run is recorded where the optimistic lock permits it.

## Flow F — post-generation refinement

1. Ask Meri to shorten a paragraph.
2. Verify a proposal is created.
3. Verify the proposal does not auto-apply.
4. Accept explicitly.
5. Verify the generated document updates and persists after reload.

## Regression

- Existing `/workspace` library still loads.
- Existing `/workspace/studio` still loads.
- Existing draft routes still use the stabilized editor.
- Existing comments, collaborators, locks, versions, quality and delivery continue to work.
- Legacy `app.capiro.ai` Workspace routes are unchanged.
