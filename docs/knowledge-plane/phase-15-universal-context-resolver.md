# Knowledge Plane Phase 15 — Universal Context Resolver

## Status

Implemented on `agent/knowledge-plane-phase-15-universal-context-resolver`.

Phase 15 adds the shared pre-retrieval resolver that separates:

1. **SecurityScope** — what the caller is allowed to see;
2. **SubjectScope** — what the user is actually asking about;
3. **FocusEntities** — the entities that matter to this request;
4. **UI context** — useful hints that never grant access or silently define the subject.

The resolver runs before Retrieval V2. It does not replace Retrieval V2, the Universal Entity Resolver, the existing Context Compiler, or ContextPacket persistence.

## Absolute rules

The implementation enforces the master-plan rules:

- UI selection is not authorization.
- UI focus is not automatically SubjectScope.
- A selected client becomes subject only when `subjectScope='client'` is explicit.
- A current object becomes a focus entity only when `includeCurrentObjectAsFocus=true` is explicit.
- Client and mailbox scope never grants access; source adapters intersect the proposed scope with tenant, ownership, RLS, and ethical-wall rules.
- Ambiguous or unresolved external identity stops retrieval.
- External lookup requires both a request-level opt-in and a SecurityScope policy opt-in.
- Phase 15 never automatically registers a public canonical entity.

## Shared contract

`apps/api/src/context/context-resolver.types.ts` defines:

```ts
interface ContextResolutionRequest {
  tenantId: string;
  actorUserId: string;
  surface: ContextSurface;
  task: string;

  securityScope: {
    authorizedClientIds?: string[];
    authorizedMailboxConnectionIds?: string[];
    graphPartitions?: TemporalKnowledgeGraphPartition[];
    allowExternalLookup?: boolean;
  };

  subjectScope?: 'client' | 'portfolio' | 'external_entity' | 'general';
  subject?: {
    query?: string;
    entityTypeHint?: string;
    identifiers?: EntityIdentifierInput[];
    maxCandidates?: number;
    allowExternalLookup?: boolean;
  };

  focusEntityRefs?: KnowledgeRef[];
  clientId?: string;
  currentObject?: { type: string; id: string };
  includeCurrentObjectAsFocus?: boolean;
  sessionId?: string;
  asOf?: Date;
  maxTokens?: number;

  retrieval?: ContextRetrievalDirective;
}
```

The optional retrieval directive exists so the same service can either:

- resolve scope only; or
- resolve scope and then invoke shared Retrieval V2.

The repository already has the compiler-side ContextPacket v1/v2 rollout contract. The master-plan Phase 17 scope, coverage, source-health and completeness upgrade remains separate from this resolver phase.

## Shared surface vocabulary

Phase 15 reuses `@capiro/meriv2-core`'s existing `ContextSurface` vocabulary for surfaces already represented by the compiler, including chat, in-editor, workspace, strategy, outreach, memo and research paths.

The resolver contract adds only product surfaces not yet present in that compiler union, such as portfolio, client profile, engagement, Program Elements, LegiWatch, hearings, grants, contracts, directory and the generic API entry point.

This avoids creating a second name for an existing context surface while allowing the universal resolver to serve the wider Capiro product later.

## SubjectScope behavior

### Client

Requires:

- explicit `subjectScope='client'`;
- explicit `clientId`;
- that client inside the proposed authorized-client envelope.

The source adapter independently verifies tenant and ethical-wall visibility before returning records.

### Portfolio

Requires at least one authorized client. The portfolio subject consists of the complete normalized authorized-client envelope supplied to the resolver, then independently checked by the source adapter.

### External entity

Requires either:

- explicit identity input; or
- an explicit canonical entity focus reference.

Identity input is passed through the existing `UniversalEntityResolutionOrchestratorService` before retrieval.

Outcomes:

- `resolved` with a canonical entity ID → retrieval may proceed;
- `ambiguous` → retrieval is blocked and candidate summaries are returned;
- `unresolved` → retrieval is blocked;
- resolver error → retrieval is blocked with a provider-neutral stop reason.

The resolver always sets:

```text
allowAuthoritativePublicRegistration = false
```

Phase 15 resolves request scope; it does not automatically grow the canonical registry.

External lookup is fail-closed and requires **both**:

```text
securityScope.allowExternalLookup = true
subject.allowExternalLookup = true
```

Either omission or a false value keeps external lookup disabled. Deterministic internal/canonical resolution may still run before returning an unresolved or ambiguous result.

### General

General is the default when the caller supplies neither an explicit subject scope nor explicit subject identity input.

A selected UI client remains UI context only. It is not copied into Retrieval V2's subject subset.

## FocusEntities

Focus refs are explicit, deduplicated stable references.

Rules:

- explicit canonical references contribute canonical entity IDs to Retrieval V2;
- explicit client focus must be inside SecurityScope;
- a client subject is also a focus entity;
- current-object UI context is not focus unless explicitly promoted;
- focus never expands authorization.

## SecurityScope handoff

Phase 15 extends `RetrievalCallerContext` with separate envelopes:

```ts
authorizedClientIds?: string[];
authorizedMailboxConnectionIds?: string[];
clientIds?: string[]; // explicit SubjectScope subset
```

This fixes the earlier ambiguity where one field could be mistaken for both permission and question focus.

The core Prisma adapter now:

1. normalizes the complete authorized-client envelope;
2. intersects it with tenant-scoped ethical-wall visibility;
3. verifies any explicit SubjectScope subset is contained in that envelope;
4. returns `unauthorized` coverage before querying a domain when any mismatch exists;
5. filters client-linked records to the resulting permitted subset.

For mailbox retrieval, the adapter now:

1. verifies every requested mailbox connection is owned by the actor;
2. restricts message reads to those exact connection IDs;
3. computes source health/freshness only from that selected set;
4. returns `unauthorized` coverage before reading mail if the requested set is not fully authorized.

The existing user ownership and message-removal predicates remain mandatory.

The normalized SecurityScope in a scope-only response is still a proposed server envelope, not proof that a browser-supplied list was authorized. Actual access is independently rechecked at the source adapter when retrieval runs.

## Retrieval construction

When retrieval is requested, the resolver creates one ordinary `RetrievalRequest` containing:

- actor/tenant identity;
- SecurityScope envelopes;
- explicit SubjectScope client subset;
- authorized graph partitions;
- resolved canonical entity IDs;
- query class and requested domains;
- temporal parameters;
- a small resolver trace in request metadata.

The resolver then invokes `RetrievalV2Service`. It does not call domain tables directly and does not create a second retrieval planner.

The Phase 11 exact-client rail predates the separate authorization field. Until that service consumes `authorizedClientIds` directly, the resolver safely bridges a non-empty authorized envelope into its existing exact client subset field. An explicitly empty envelope fails closed rather than becoming an unscoped lookup.

## Existing Context Plane integration

The repository already contains a Context Compiler and request-local persistence boundary. Phase 15 extends the existing `ContextModule`; it does not replace those services.

`ContextModule` now exports:

- `ContextCompilerService`;
- `ContextPersistenceBoundaryService`;
- `ContextResolverService`.

This preserves one shared Context Plane rather than introducing a Meri-only resolver.

## Observability

Every resolution returns a deterministic trace including:

```text
resolver version
UI client selected
UI client within the proposed SecurityScope envelope
UI client used as subject
current object selected
current object used as focus
external lookup permitted
external lookup ran
retrieval planned
```

The trace deliberately says **within the envelope**, not **authorized**. Source adapters make the actual access decision.

## Tests and architecture guards

Phase 15 adds tests proving:

- UI client selection does not become SubjectScope;
- explicit client subject requires the proposed authorized envelope;
- unauthorized client subject fails closed;
- portfolio scope uses the authorized envelope;
- external entity resolution completes before retrieval;
- ambiguous identity blocks retrieval;
- external lookup requires double opt-in;
- public canonical registration remains disabled;
- current-object focus is opt-in;
- mailbox subsets are carried into Retrieval V2;
- exact client lookup remains scoped during the transition;
- client authorization is intersected with ethical walls;
- mailbox ownership is checked before message reads;
- mail queries and health are restricted to the exact authorized mailbox set;
- the resolver owns no Prisma storage, embeddings, reranker, or reasoning model;
- the existing compiler and persistence boundary remain in the shared module;
- existing compiler surface names are reused rather than duplicated.

## Rollout behavior

Phase 15 introduces no production feature flag and does not automatically reroute Meri or other product surfaces.

The service is available through the shared `ContextModule`. Product-surface cutover remains a later controlled phase. This makes the merge architecture-safe while preserving current runtime behavior.

## Infrastructure impact

Phase 15 is application-code only:

- no Prisma migration;
- no new table or index;
- no pgvector change;
- no embedding or re-embedding change;
- no AWS resource;
- no NVIDIA resource or flag change;
- no historical backfill.

No AWS action is required merely to merge Phase 15.

## Explicit non-goals

Phase 15 does not:

- create a new source of truth;
- replace the existing Universal Entity Resolver;
- replace Retrieval V2;
- create another graph or vector store;
- decide factual truth from retrieval relevance;
- compile or redefine the five context layers;
- implement the master-plan ContextPacket scope/coverage upgrade;
- migrate Meri or another surface onto the resolver;
- change model reasoning;
- automatically register public entities;
- perform external research without explicit request and policy permission.

Phase 16 preserves and formalizes the five context layers. Phase 17 carries the resolved scope and coverage into the existing ContextPacket V2 architecture. Later cutover phases move product surfaces onto this shared entry point.
