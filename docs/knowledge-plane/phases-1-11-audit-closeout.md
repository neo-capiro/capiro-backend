# Knowledge Plane Phases 1–11 — Audit Closeout

## Audit baseline

- Repository: `neo-capiro/capirov2`
- Audited base: `main @ a19a86a5fe96b15bbe63a29d01ba11d4cc255aeb`
- Closeout branch: `agent/knowledge-plane-phases-1-11-audit-closeout`
- Scope: Phases 1–11 only. This closeout does not begin Phase 12 or alter embedding providers, vector dimensions, reranking, ContextResolver, ContextPacket, or Meri reasoning.

## Architecture invariants rechecked

The audit preserved the existing architecture:

- one `KnowledgeEvent` ledger;
- durable assertions with immutable evidence and provenance;
- one canonical identity layer and one Temporal Knowledge Graph;
- PostgreSQL + pgvector as the shared vector substrate;
- Retrieval V2 as the shared exact/semantic/temporal/relationship query plane;
- tenant, user-ownership, and ethical-wall boundaries fail closed;
- zero records never imply complete coverage without a positively completed authoritative scan;
- generated AI output is not evidence and reasoning remains outside the Knowledge Plane.

## Phase-by-phase result

| Phase | Result | Audit evidence |
| --- | --- | --- |
| 1 — KnowledgeEvent | Verified | Append-only service/repository path, tenant-scoped idempotency identity, conflict-safe insert, source/hash validation, and no parallel change ledger. |
| 2 — KnowledgeAssertion | Verified | Assertions require evidence, validate authority/confidence/bitemporal semantics, inherit source scope, and preserve conflict/supersession rather than silently rewriting claims. |
| 3 — KnowledgeEvidence | Verified | Evidence is source-bound, hash/offset/excerpt checked, non-AI, append-only, tenant-scoped, and created transactionally with assertions. |
| 4 — Mailbox source health | Fixed | Retrieval previously treated missing mailbox availability as a complete healthy empty scan and could use another integration's freshness. It now reports authorized mailbox availability, connection state, incomplete sync, and the stalest completed authorized sync explicitly. |
| 5 — Universal Entity Resolution | Verified | Deterministic exact identity resolution remains first, ambiguity fails closed, public/private identity boundaries are preserved, corrections are append-only, and no blind fuzzy/model merge path was introduced. Current migration-contract expectations align with the migration. |
| 6 — Canonical IDs in extraction | Verified | Mailbox extraction resolves canonical identity before durable extraction, remains feature-gated, rejects AI source identity, and does not invent uncertain identity. |
| 7 — Entity-aware Knowledge Episodes | Verified | Episodes remain deterministic projections above assertions/evidence rather than a second memory database. Current migration-contract expectations align with the migration. |
| 8 — Temporal Knowledge Graph | Verified | Historical reads resolve terminal canonical identity at read time, preserve immutable assertion/evidence lineage, cap merge/traversal depth, and fail closed on cycles, malformed lineage, or tenant crossing. |
| 9 — Retrieval V2 | Fixed | Existing source coverage and exhaustive-pagination contracts remain intact. Core retrieval now reuses established user-ownership predicates for mail, meetings, and outreach; failed exact sources return explicit incomplete `error` coverage instead of rejecting the whole response. |
| 10 — pgvector architecture lock | Verified | One `ContextEmbedding` vector substrate remains enforced; feature-specific vector databases/delegates and alternate vector vendors remain forbidden by contract. |
| 11 — Exact / Lexical Retrieval | Fixed | Canonical program lookup now uses the normalized expression indexed by Phase 11; client-domain lookup scans the complete authorized set instead of capping a broad substring prefilter; per-domain failures remain visible in coverage. No search table or shadow entity dictionary was added. |

## Defects fixed

### 1. Same-tenant private-context leakage in the core Retrieval V2 adapter

The adapter had independently re-derived access rules instead of reusing the established engagement predicates:

- mail was not restricted to the caller's mailbox connection;
- meetings could be returned based on `sharedAt` without the canonical creator/connection-owner predicate and deleted meetings were not excluded;
- outreach was not owner-scoped and reserved `outreach_v3` compatibility roots were not excluded.

The adapter now imports and applies `ownMailMessageWhere`, `ownMeetingWhere`, and `ownOutreachRecordWhere`.

### 2. Mailbox zero-result completeness and freshness

Mail retrieval previously queried the newest `lastSyncAt` from any connected integration and returned healthy/complete when no mailbox connection existed. It now:

- scopes mailbox health to the caller;
- considers only mailbox-capable providers for sync health;
- distinguishes no connection, no connected mailbox, partially disconnected mailboxes, and incomplete initial sync;
- reports the stalest completed authorized mailbox sync rather than a fresher unrelated integration;
- keeps coverage incomplete whenever mailbox availability or sync health is not proven.

### 3. Exact client-domain false negatives

The previous implementation used `website contains <domain>` with a 501-row cap and only then normalized candidate websites. More than 501 substring matches could hide the real exact domain while coverage was reported complete.

The exact rail now walks the authorized client set in bounded pages, normalizes every non-null website, and stops early only after the 500 exact-match safety cap is exceeded.

### 4. Canonical program-name/index mismatch

The Phase 11 migration created a normalized canonical-program expression index, but runtime lookup compared raw `canonicalName` case-insensitively. Punctuation/spacing-equivalent exact names could miss and the index was not used.

Runtime lookup now uses the same normalized SQL expression as `program_canonical_name_exact_idx` and still unions canonical and `ProgramAlias` matches without introducing a duplicate index architecture.

### 5. Exact-source failures bypassing CoverageManifest

A database/provider exception in one exact domain previously rejected the full exact-retrieval call. Retrieval V2 could not return healthy domain results or explain the failed source.

Each requested exact domain is now isolated. A failure produces `sourceStatus=error`, `coverageComplete=false`, `paginationComplete=false`, and `stopReason=exact_lexical_source_failed`; healthy domains remain in the response.

## Regression coverage added

Focused retrieval tests now prove:

- mail queries carry the established connection-owner and active-message predicates;
- no mailbox connection cannot become complete empty coverage;
- disconnected or incompletely synced authorized mailboxes degrade coverage;
- freshness reports the stalest authorized mailbox sync;
- meeting queries use creator/connection ownership and exclude deleted meetings;
- outreach queries require the caller owner and exclude reserved internal roots;
- one failed exact source does not discard healthy requested domains;
- an exact domain after 501 substring decoys is still found and coverage is truthful;
- canonical program lookup uses the same normalized expression as the Phase 11 index.

## Validation boundary

The dedicated Phase 11 workflow already runs the full retrieval Jest directory, canonical identity regressions, Prisma validation/generation, TypeScript attribution checks, the complete migration chain against disposable pgvector/PostgreSQL, and physical index verification.

Repository-level GitHub Actions startup failures must remain classified as execution-layer failures when no job is scheduled. They are neither green CI nor a Knowledge Plane test failure. Local/focused test output and workflow/job evidence must be recorded separately before merge.
