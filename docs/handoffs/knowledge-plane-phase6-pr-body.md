## Summary

Phase 6 live canonical mailbox extraction is validated and ready for review.

Pipeline:

`mail provider row -> Phase 4 normalization/relevance -> KnowledgeEvent -> Phase 6 durable extraction job -> canonical envelope resolution -> structured claim extraction -> exact evidence validation -> canonical subject/object resolution -> KnowledgeAssertion + KnowledgeEvidence`

## Safety and scope

- Extraction is a separate rollout arm: `MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED` defaults to false. This PR does not enable production extraction.
- The model produces candidate claims only. Canonical subject/object identity is resolved by the existing Phase 5 universal entity resolver.
- Every mailbox-originated resolver call sets `allowExternalLookup: false`.
- Linked client and access scope come from immutable `KnowledgeEvent.clientRefs` / event scope, not a later mutable message association.
- Evidence is accepted only when the model excerpt is an exact contiguous substring of authoritative mailbox source text; durable proof remains `KnowledgeEvidence`.
- Candidates are checkpointed before assertion writes. Retries reuse the checkpoint without another LLM call; assertion idempotency prevents duplicates after partial success.
- Ambiguous/unresolved identity, malformed output, weak claims, and invalid evidence are held or dropped without durable assertions.
- No historical mailbox backfill, second scheduler, RAG stack, resolver, graph, evidence ledger, credential store, or model gateway was added.

## Validation executed locally

Validated from a runnable Windows/MSYS checkout of the exact branch after merging latest `origin/main` (`ac6d93af818330da65fc4969811c86716cdb1cb6`) for conflict-safe validation:

- Focused command: **PASS — 7 suites, 46 tests**.
- Full `pnpm --filter @capiro/api exec jest --runInBand --forceExit src/knowledge`: **PASS — 51 suites, 253 tests**.
- `pnpm --filter @capiro/api exec prisma generate`: **PASS**.
- `pnpm --filter @capiro/api exec prisma validate`: **PASS**.
- Full migration chain on disposable `pgvector/pgvector:pg16`, database `capiro`: **PASS**.
- Database inspection: extraction table exists; four FKs, unique event/job constraints, status/count/hash/scope/lock/result checks, extraction trigger, forced RLS, tenant policy, and no app DELETE/TRUNCATE grant verified.
- Trigger rehearsal: valid incremental/full Phase 4 input produced one Phase 4 job; valid active event success produced exactly one Phase 6 job; replay remained exactly one; migration created no historical Phase 6 jobs.
- RLS rehearsal: tenant A saw its row, tenant B saw zero rows, and a cross-tenant update affected zero rows.
- Negative SQL probes: invalid hash/scope, cross-tenant links, duplicate replay, and inactive-event enqueue failed closed; a 20-minute processing lease was reclaimed and attempt count incremented.

## TypeScript baseline distinction

The required `pnpm --filter @capiro/api exec tsc --noEmit` command exits nonzero. A clean `origin/main` checkout with the same workspace setup produced the same unrelated baseline errors: script imports outside `rootDir`, existing `import.meta`/CommonJS mismatch, and pre-existing Méri/reviews/intelligence type errors. No Phase 6 file appears in those diagnostics. This is documented as a non-blocking repository baseline limitation, not a Phase 6 regression.

## Operational rollout

1. Deploy migration/code with extraction off.
2. Verify queue and worker health.
3. Enable extraction only for a tightly controlled tenant/sample.
4. Inspect held/asserted ratios and evidence quality.
5. Broaden only after review.

`drain-mailbox-knowledge` drains Phase 4 first and Phase 6 second only when the separate extraction flag is enabled; there is no dependency loop or second scheduler.

GitHub Actions currently reports an infrastructure `startup_failure` with zero jobs scheduled; it is not treated as code-test validation.

## Merge status

PR #972 is not merged by this change. The branch remains `agent/knowledge-plane-phase-6-mailbox-extraction` and production extraction remains disabled by default.
