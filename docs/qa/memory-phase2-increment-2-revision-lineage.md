# Memory Review UX Phase 2 — Increment 2 Revision Lineage

## Scope completed

This increment implements immutable proposer revision and resubmission after an assigned reviewer records `changes_requested`:

- proposer-only `POST /memory/review/candidates/:id/revise` route;
- immutable successor candidate rather than in-place candidate mutation;
- root, predecessor, successor, and monotonic revision-number lineage;
- row locks on the predecessor candidate and its review workflow;
- exactly one successor per predecessor and one candidate per root/revision number;
- atomic successor creation, predecessor supersession, and predecessor workflow supersession;
- fresh canonical authorization before cloning and again after successor creation;
- a fresh named-reviewer workflow for the successor;
- no active `memory_items` or `clio_memory` mutation during revision;
- bounded immutable revision input that permits only content changes;
- canonical memory accepts one browser-controlled channel: the complete section set;
- canonical `value` is derived server-side from revised sections;
- immutable correction text uses the same normalized section-text encoding as initial correction submission;
- revised source-content hash, source version, origin trace, and provenance are regenerated for the successor;
- original reviewer decision attribution is preserved when the proposer supersedes the changes-requested workflow;
- audit output stores hashes, lineage IDs, revision counts, and change counts rather than memory bodies.

## Security and correctness repairs made during review

The recovered draft implementation had four defects that were corrected before acceptance:

1. Canonical proposals could carry conflicting browser-provided `value` and `sections`.
2. A successor inherited stale `source_content_hash`, `source_version`, and `origin_trace_id` from its predecessor.
3. Predecessor workflow supersession replaced the reviewer's `decided_by` and `decided_at` with the proposer.
4. Authorization was evaluated only before cloning, not again on the created successor before its new review workflow opened.

The accepted implementation rejects the second content channel, regenerates revision-owned identity, preserves reviewer attribution, and rolls the transaction back when successor authorization is no longer valid.

## Focused validation completed

Passed in the available isolated environment:

- strict TypeScript check for the exact production revision helper and service sources;
- helper runtime probes for canonical dual-channel rejection, derived canonical consistency, correction text encoding, and non-canonical value revision;
- service runtime probes for successful immutable revision, successor authorization denial, and concurrent-successor conflict translation;
- migration structural/static contract: 13 checks covering locks, uniqueness, workflow state, source identity refresh, attribution preservation, and absence of active-memory DML;
- post-change GitHub diff and tenant/security review.

Committed focused Jest coverage additionally covers proposer-only behavior, first and second authorization gates, immutable correction encoding, lineage/audit fields, stale-workflow conflicts, migration invariants, and no memory-body audit leakage. The full repository Jest suite was not executable in this environment and is not claimed as run.

## Prisma ownership and remaining executable gate

The four lineage columns are introduced by the additive SQL migration and are accessed only inside the locked SQL revision function in this increment. They are not read or written through Prisma Client delegates.

Before Phase 2 final acceptance, the repository must still prove one of the following on a complete checkout:

1. model the lineage columns in `MemoryCandidate` and pass Prisma validate/generate plus clean and upgrade migration replay; or
2. retain them as explicitly SQL-owned columns and add a permanent drift/closeout gate proving Prisma tooling will not reconcile or remove them.

This increment does not claim that final Prisma/migration gate.

## Gates not claimed

- full dependency installation;
- full API Jest memory suite;
- root monorepo typecheck;
- pinned repository Prettier;
- Prisma validate/generate;
- clean and upgrade PostgreSQL migration replay;
- real-role RLS and concurrent-transaction database tests;
- web build, Vitest, and authenticated browser acceptance;
- GitHub Actions.

## Next increment

Before notifications or the Review Inbox redesign, close the revision persistence compatibility gate on a complete repository/runtime:

1. reconcile Prisma ownership of the four lineage columns;
2. add clean and upgrade PostgreSQL migration replay;
3. execute real concurrent revision tests;
4. verify RLS with proposer, assigned reviewer, unauthorized tenant member, walled administrator, and cross-tenant identities;
5. verify compatibility decision routes cannot bypass revised-candidate lineage or assignment enforcement.

## Safety boundary

Keep PR #761 draft. Do not merge, deploy, apply either Phase 2 migration, backfill production data, or enable production flags from this increment.
