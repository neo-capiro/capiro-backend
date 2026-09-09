# Meri Phase 4 — complete workspace workflows

This extends draft PR #1557 from Phase 3 head `62819f7c878b9edce7011a3c75cd267d18d1361c`, addressing MW-06, MW-07, MW-08, MW-09, MW-12 and MW-13 in the [Phase 0 register](phase0-contract-map-2026-09-09.md). The [Phase 2](phase2-implementation-2026-09-09.md) and [Phase 3](phase3-implementation-2026-09-09.md) repairs remain in the same PR. Canonical conversation membership, saved prompts, message metadata, Institutional Memory governance and provider reasoning remain authoritative. No migrations or dependency changes are required.

## Behavior

| Finding | Repair | Contract preserved |
| --- | --- | --- |
| MW-06: workspaces cannot organize chats | Chat options offer Add, Move and Remove. Workspace selection filters its chats; All chats returns to the full list. Create exposes the client choice, counts come from active owned membership, and deletion clears membership while retaining chats. Errors preserve the selection for retry. | Uses `clioConversation.workspaceId` and the existing owned workspace API. Client workspaces accept matching-client chats; All clients workspaces accept mixed clients. Membership never changes a chat's client or historical answer scope. |
| MW-07: QA/PDF/READY treated as companies | The active API and fallback orchestrator share explicit research/relationship/comparison request detection. Formatting instructions, attachment titles, literal output and quoted instructions do not become external subjects merely because they contain capitalized words. | Actual company/domain/mail/comparison inquiries still resolve. Selected-client and explicit portfolio intent survive into the resolver, tool adapter and persisted turn scope. Historical receipts are not rewritten. |
| MW-08: completed turns say Working | Inspector and transcript project Completed, Stopped, Failed or Incomplete from the existing final receipt and persisted `finishReason`/`partial`. Requested/effective model facts occupy their own row. Old rows with no outcome remain neutral. | No additional lifecycle store or reasoning system. Late provider/tool updates cannot reopen a terminal turn. A pinned inspector reconciles its exact message while retaining its historical scope. |
| MW-09: busy composer promises unavailable guidance | Busy copy describes Stop. Stop immediately marks the current ordinary turn; its existing request-epoch protection permits the next submission without stale updates. | No unsupported live-steering capability added. Native legacy responses now emit and save matching outcomes for completion, cancellation, provider errors, output limits and interrupted streams. |
| MW-12: Save prompt missing | User-message actions include Save prompt. Both Start Work and composer expose the same saved prompts and Manage prompts for naming, editing, reuse and deletion. Failures retain entered text and show retryable errors. | Existing tenant/user-scoped prompt CRUD and shared query cache. Reuse inserts editable text without sending or changing client/files. Identity change cancels pending writes, including requests waiting for an authentication token. |
| MW-13: feedback selection lost on reload | Both history surfaces hydrate current-user feedback. Up/down/clear writes serialize by message, show pending/error states, and restore the prior selection on failure. Reasons and notes remain available for retry. | Existing durable message ID and metadata. An owned row lock serializes updates; JSONB changes only the feedback field. Identical retries do not duplicate signals; optional learning capture is isolated by a savepoint so capture failure cannot roll back valid feedback. |

Workspace client changes require removing every member first, including archived chats. Changing a member chat to an incompatible client returns an actionable conflict and restores the saved picker value. Assignments check the conversation's current client when writing; assignment, workspace updates and deletion use a consistent workspace-before-conversation lock order. These checks prevent a simultaneous move/client change from silently producing incompatible membership.

## Validation

484 distinct tests pass across 36 focused suites, including earlier-phase regressions. The batches do not double-count reviewer reruns or shared suites.

| Verification batch | Suites | Tests |
| --- | ---: | ---: |
| API: workspace membership, client guards, saved library and durable feedback | 5 | 58 |
| API: native lifecycle and existing V3 proxy regressions | 2 | 34 |
| API: subject classification, active resolver/adapter scope and memory scope | 3 | 91 |
| Orchestrator: fallback retrieval intent and plan | 2 | 52 |
| Web: combined Phase 4 workflows plus earlier download, source, scope, proposal, attachment and draft regressions | 24 | 249 |

Two independent reviews found and resolved workspace deletion lock inversion, embedded-text misclassification, feedback transaction-abort recovery, delayed-authentication prompt writes and in-band provider-error handling. Repaired paths were independently rechecked; no remaining blockers were identified. Published files are checked against the tested local bytes, with every modified base file compared to the existing PR head before publishing.

The fixtures exercise real service/controller methods, the native provider stream parser, the active context resolver and adapters, canonical UI API wrappers, React rendering, persisted-history normalization and remounts. Saved-prompt cancellation tests use the real API client with deferred token acquisition; feedback tests model PostgreSQL's aborted-transaction behavior with the canonical learning capture service. These are controlled-port tests, not deployed browser, provider, or real PostgreSQL/RLS acceptance.

Web TypeScript passes. API TypeScript has exactly the same ten diagnostics as the untouched prior-phase baseline. Shared core build, orchestrator typecheck and whitespace checks are verified before publication. There are no database migrations, production record rewrites or changes to the Phase 3 SAM ingestion gate.

## Candidate deployment acceptance

This candidate has not been merged or deployed. Phase 4's live exit gate remains open until the following checks pass against the deployed candidate revision:

1. Create a client workspace and an All clients workspace. Add a matching chat, select the workspace, open the chat, reload, move it, remove it, and reload again. Verify counts and absence from the old workspace. Try a different-client chat, a general chat, a foreign identity, and simultaneous move/delete/client changes. Delete a workspace and verify that its active and archived chats still exist.
2. Under a selected client and again without one, ask: `QA Sep 9: In one sentence, explain the difference between authorization and appropriations.`; `Extract the fields from the attached synthetic QA brief.`; `Create a Word document and PDF using the synthetic brief.`; and `Reply with exactly READY. Do not use tools or save memory.` Inspect the actual retrieval and saved scope, then reload. Include literal text containing `Research QA` and a document titled `Research READY`. None should invent an external company. Separately ask for Anduril company research, relationship history, a domain lookup and an all-client comparison to verify legitimate subject changes.
3. Observe one completed turn, one explicit Stop, an output-limit interruption and a controlled provider error, including an in-band stream error. Check the inspector during execution, after termination and after reload. Send a new turn after Stop. Deliver late frames for the stopped turn and confirm they cannot change the next turn or restore Working. Requested/effective model details must stay separate from outcome.
4. Save a user prompt, name it, reload, and insert it from each prompt entry point. Edit/rename, retry a failed save, and delete it. Reuse must remain editable and retain the selected client and attachments without auto-sending. Switch account while token acquisition is pending and confirm no previous-account write dispatches.
5. On a freshly persisted assistant message, set up, down and clear; reload after each. Exercise `up → down → up`, `up → clear → up`, a failed write and retry, and optional learning-capture failure. Verify another user cannot read or change the feedback. Confirm retry preserves reasons/note and no stale response overrides a newer route or identity.
6. Repeat edit/resend, regenerate, Enter/Shift+Enter, attachment upload/removal, unsent-draft restoration, authenticated downloads, historical source inspection and proposal-target checks from the earlier phases. Phase 5 PDF-export completion remains separate work; the Phase 4 PDF inquiry checks routing only.

The deployed attachment/OCR, real database ownership/concurrency and generated-answer checks from prior phases also remain required. Existing historical metadata-only memory and the disabled SAM backfill/canary gate retain their Phase 3 limitations.
