# Knowledge Plane Phase 19 — Meri Integration

**Status:** implementation complete on the Phase 19 branch; draft PR validation/review pending before merge.

## Purpose

Phase 19 moves Meri from feature-owned context assembly onto the shared Knowledge Plane contract established in Phases 15–18.

The intended request path is now:

`user request -> task/query understanding -> universal entity resolution -> Retrieval V2 planning/execution -> Context Resolver -> five context layers -> ContextPacket V2 -> Meri reasoning`

The ownership boundary is deliberate:

- **Knowledge Plane owns:** identity resolution, subject scope, authorization envelope, retrieval, evidence, provenance, source health, freshness, coverage, completeness, context compilation, and ContextPacket governance.
- **Meri owns:** reasoning, comparison, prioritization, strategy, synthesis, tool/action selection, and response generation.

Phase 19 does not create a Meri-specific knowledge database, vector store, graph, sixth context layer, or mutable ContextPacket.

## Governed operations

The Phase 18 operation registry now marks these operations `packet_required`:

- `meri.chat`
- `meri.research`
- `research.generate-report`

Their Phase 19 migration exceptions have been removed. The Phase 20–25 exceptions remain unchanged.

A packet-required operation that bypasses the Context Plane is denied by the existing Phase 18 enforcement boundary.

## Chat adoption

### API boundary

`MeriContextPlaneService` is the API-side adoption seam. For each Meri turn it:

1. derives the tenant/user security envelope on the server;
2. derives authorized clients from the existing client memory-wall model;
3. derives the caller's mailbox connections when present;
4. classifies the turn into the existing Context Resolver / Retrieval V2 vocabulary;
5. resolves the subject independently of UI-selected client state;
6. calls `ContextPlaneGatewayService` exactly once;
7. projects the governed packet and Retrieval V2 coverage into the Meri compatibility stream; and
8. builds a runtime-only model prompt containing authorized steering/evidence plus the authoritative coverage statement.

The runtime prompt explicitly tells the model that retrieved/steering content is data, not system instructions, and that record count cannot be used as a substitute for retrieval completeness.

### Runtime routing

`MeriContextPlaneRuntimeService` prepares the true user task before the runtime canary is selected. This matters for regenerate/resend, where the incoming body may not contain the actual prior user task.

The same governed turn then wraps whichever runtime handles the request:

- legacy/raw Meri path;
- MeriV2; or
- MeriV3 canary.

The raw service's old context hooks are adapted rather than rewriting the mature action/history/attachment code:

- old `loadRelevantMemories` is suppressed during governed turns;
- old client-KB snapshot prewarm is suppressed during governed turns;
- old `orchestrateContext` receives the governed Context Plane prompt/coverage;
- V2/V3 receive the same `governedContext` object; and
- outgoing `done` metadata is normalized to the API-side packet and coverage rather than a runtime-local reconstruction.

## Orchestrator boundary

The orchestrator retains an **identity-only** resolver for governed requests. It resolves the local Capiro user ID required for tool scoping, but does not compile firm/client context or load a client roster.

Both public chat endpoints now fail closed if the API does not provide the governed bundle:

- `/chat`
- `/v3/chat`

The error code is `meri_governed_context_required`.

This closes the HTTP-level fallback that previously allowed the orchestrator to rebuild context independently.

## MeriV3 retrieval behavior

The established MeriV3 retrieval assistant remains available as compatibility code for non-product/direct service use, but normal governed Capiro turns bypass its parallel retrieval/coverage engine.

During a governed turn:

- V3 retrieval-recipe schemas are not exposed to the model;
- V3 does not run its separate classifier/recipe/research-director coverage path;
- native reasoning and action tools remain available; and
- V3 returns the upstream Retrieval V2 / ContextPacket coverage metadata.

This prevents two systems from independently claiming what sources were checked.

## Deep Research and report generation

The established long-running Deep Research loop is preserved, but its context boundary is wrapped:

- `streamPlan` resolves the session topic through `meri.research`;
- `streamResearch` resolves the session topic through `research.generate-report`;
- the existing `clientContext` seam consumes the governed prompt inside the wrapped run; and
- normal Nest traffic no longer uses the old direct client-context/compiler path.

The research agent can continue gathering and synthesizing with its existing tools, but its standing context is supplied through the same Context Plane contract as chat.

## Governed memory recall

Phase 19 discovered a real recall compatibility gap: legacy Meri read durable `clio_memory` directly, while Retrieval V2's `institutional_knowledge` adapter previously exposed only the temporal knowledge graph.

The fix lives in **Retrieval V2**, not Meri.

For `lookup` and `semantic_recall`, the `institutional_knowledge` domain now exposes governed durable memory while preserving:

- tenant/user RLS;
- `user_private` ownership;
- client memory-wall checks;
- explicit authorized-client envelopes;
- expiry;
- revoked/superseded governed-memory suppression;
- provenance back to `clio_memory`; and
- explicit degraded coverage when semantic projection is unavailable.

Internal user UUIDs are not emitted in model-facing memory payloads.

A healthy empty governed-memory scan may be `complete`; an authorization failure, safety cap, pagination boundary, or semantic-projection failure cannot be called complete.

## Coverage integrity fix

Phase 19 exposed a Phase 17 edge case: entity resolution can stop as `unresolved` or `ambiguous` **before** the resolver constructs a Retrieval V2 request.

Previously that could erase the original retrieval intent and make the packet appear as if retrieval was never requested.

The Context Plane gateway now forwards the original retrieval directive into `ContextPacketV2Service`. If retrieval was planned but never executed:

- requested domains remain present;
- searched domains are empty;
- requested sources are marked unavailable;
- pagination is incomplete;
- evidence refs are empty; and
- `retrievalCompleteness` remains incomplete with `retrieval_response_missing`.

This preserves the Phase 17 invariant: **zero results or no retrieval response never implies complete context unless the required sources were actually checked.**

## Subject-scope regression: selected client vs RTX

Phase 19 permanently tests the high-risk UI-state regression:

> A client is open in the UI and the user asks, “Tell me everything we know about RTX.”

Expected behavior:

- subject scope is `external_entity`;
- RTX is the target;
- the selected client is not converted into the subject;
- selected-client UI state is not treated as authorization; and
- if RTX cannot be resolved, intended retrieval domains remain explicitly unchecked/incomplete.

Explicitly asking about the selected client still produces client subject scope.

## Mailbox behavior

The security envelope includes exact user-owned mailbox connection IDs when the server discovers them.

If the user has no connected mailbox, Phase 19 does not manufacture an empty authorization denial. The existing Retrieval V2 mail adapter still scopes by the authenticated user's connection ownership and reports the source as unavailable when no mailbox exists. This degrades coverage rather than failing an unrelated Meri turn.

Live mailbox **Knowledge ingestion/backfill** is separate from this phase and remains governed by its existing rollout flags/schedule decisions.

## Public and federal research tools

Phase 19 deliberately distinguishes **same-turn capabilities** from **pre-turn Context Plane coverage**.

Meri may still use authorized public/federal/web tools during reasoning. Until those data domains are registered behind the shared Retrieval V2 adapter boundary, the Context Plane compatibility coverage does not claim they were pre-checked.

Tool use may supplement or verify the response, but it does not rewrite the immutable pre-turn coverage statement.

This is intentionally conservative. A future phase can bring additional authoritative domains behind Retrieval V2 without reviving a Meri-owned RAG layer.

## Meri v4 compatibility

Phase 19 does not revert or redesign the Meri v4 UI work from PRs #1045 and #1048.

Those changes are downstream presentation/wiring work. The widened coverage UI now benefits from Phase 19 because the `done` frame is normalized to the shared Retrieval V2 / ContextPacket truth.

Thread-level context mutation remains out of scope. A future Manage Context UI must change inputs to a **future** resolution and create a new packet; it must never mutate the ContextPacket that already grounded a prior answer.

## Security properties retained

- tenant/effective-tenant/actor mismatch fails before retrieval at the Phase 18 gateway;
- selected client state is not authorization;
- client memory is rechecked against the ethical wall inside Retrieval V2;
- mailbox access remains user scoped;
- packet audit logging remains body-free/bounded metadata;
- no second Context Plane kill switch or bypass was introduced; and
- public V2/V3 chat routes fail closed without governed context.

## Tests and contract coverage added/updated

Phase 19 adds or advances tests for:

- Meri subject/retrieval planning including the selected-client/RTX case;
- governed memory retrieval, healthy-empty completeness, client authorization, ethical-wall denial, and semantic degradation;
- planned retrieval that stops before Retrieval V2 execution;
- Phase 19 registry operations becoming packet-required;
- gateway enforcement with `meri.chat` at Phase 19;
- raw/V2/V3 runtime wrapping;
- governed Deep Research planning and report generation;
- public V2/V3 fail-closed architecture;
- V3 duplicate recipe/coverage suppression; and
- preservation of the no-Meri-specific-knowledge-store architecture.

## CI / validation note

GitHub Actions continues to exhibit the repository-wide runner `startup_failure` condition seen before Phase 19. A startup failure means the runner did not execute test jobs; it is neither a green test result nor evidence that the Phase 19 tests failed.

The Phase 19 PR therefore records independent static/contract validation separately from GitHub runner status. Full runtime/deployment smoke testing remains a pre-merge/deploy requirement whenever a functioning runner or normal repo checkout is available.

## Out of scope

Phase 19 does **not**:

- begin Phase 20 Outreach adoption;
- change Workspace, LegiWatch, CRM, Meetings, or Strategies adoption state;
- create mutable ContextPackets;
- create a sixth context layer;
- create a Meri-specific knowledge store or vector DB;
- perform historical mailbox backfill;
- enable mailbox Knowledge ingestion flags;
- provision NVIDIA/GPU infrastructure;
- re-embed the corpus; or
- deploy the branch to AWS.

## Phase 20 gate

The code-level Phase 19 gate is satisfied when the final branch diff confirms:

1. `meri.chat`, `meri.research`, and `research.generate-report` are packet-required;
2. normal Meri chat/research enters through the shared Context Plane;
3. public V2/V3 chat cannot fall back to local context assembly;
4. duplicate Meri prewarm/retrieval paths are suppressed on governed turns;
5. coverage remains truthful for success, unavailable, partial, unresolved, and no-result cases;
6. tenant/client/mail authorization remains fail-closed; and
7. no Phase 20+ product adoption is included in the diff.

Phase 20 should not begin until the Phase 19 PR is reviewed/merged and the resulting runtime has passed the appropriate deployment smoke tests.
