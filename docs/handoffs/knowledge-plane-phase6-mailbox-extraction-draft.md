# Knowledge Plane Phase 6 — Live Canonical Mailbox Extraction

Status: validated closeout candidate on `agent/knowledge-plane-phase-6-mailbox-extraction` (PR #972 remains open until owner merge decision).

## Mission

Phase 6 turns eligible live mailbox `KnowledgeEvent`s into evidence-backed `KnowledgeAssertion`s without making the extraction model an identity authority and without introducing a second resolver, evidence ledger, mailbox sync path, or feature-specific RAG stack.

The production path is:

`mail provider row -> Phase 4 source-health/normalization/relevance -> KnowledgeEvent -> Phase 6 durable extraction job -> canonical envelope resolution -> model claim extraction -> exact evidence validation -> canonical subject/object resolution -> KnowledgeAssertion + KnowledgeEvidence`

## Safety / architecture invariants

1. Phase 4 still terminates at `KnowledgeEvent`. The provider sync and Phase 4 consumer do not call an extraction model.
2. Phase 6 is separately armed by `MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED`; deploying the code or migration alone does not send mailbox text to an AI provider.
3. The linked client is taken from the immutable `KnowledgeEvent.clientRefs`, not the message's current association. A later CRM re-association cannot retroactively change the client identity of old evidence.
4. Known envelope identity (linked client and sender) is resolved before extraction through the existing universal Phase 5 resolver. The extractor receives safe identity hints, never canonical UUIDs.
5. Every mailbox-originated identity resolution sets `allowExternalLookup: false`. Private source-language names/emails cannot implicitly trigger official-website lookup, public-web search, or model-assisted identity reconciliation. Canonical/CRM/contact/directory/structured-authoritative stages remain available in the same resolver.
6. The extraction model can propose only source-language mentions, atomic predicates, scalar/entity objects, assertion class/confidence, and an exact source excerpt. It cannot select or create a canonical identity.
7. An excerpt must be an exact contiguous substring of the authoritative provider text before model-derived identity resolution or assertion persistence proceeds. Existing `KnowledgeAssertionService` / `KnowledgeEvidenceValidatorService` then enforce hash, offsets, event, sensitivity, and access scope.
8. Ambiguous or unresolved identity creates zero durable assertion. The tenant-private extraction result retains the resolution disposition plus event/hash/exact evidence offsets for later review/reprocessing; it does not create a second evidence ledger.
9. Validated extraction candidates are checkpointed before any assertion write. A crash/retry reuses the same candidate set and does not call the model again; existing assertion idempotency prevents duplicates if an assertion committed before the crash.
10. The migration performs no historical mailbox backfill. Historical processing remains a later controlled phase after the live pipeline is proven.

## Durable queue

Migration: `20261120150000_mailbox_knowledge_extraction`

Table: `knowledge_mailbox_extraction_jobs`

The enqueue trigger fires only when a Phase 4 `knowledge_mailbox_jobs` row reaches `succeeded` with both a `result_event_id` and `processed_content_hash`. A second trigger verifies that the extraction job binds exactly to that same-tenant succeeded mailbox job and active `KnowledgeEvent`, including source revision, content hash, sensitivity, and access scope.

The queue uses `FOR UPDATE SKIP LOCKED`, stale-processing reclaim, bounded retry/backoff, dead-letter state, forced RLS, and no app-level DELETE/TRUNCATE grant.

The queue is intentionally accessed through the existing tenant-aware `PrismaService` raw SQL boundary in this phase; runtime does not require a generated Prisma delegate for it. The SQL migration is the table/constraint/RLS source of truth.

## Rollout controls

- `KNOWLEDGE_PLANE_ENABLED=true`
- `MAILBOX_KNOWLEDGE_ENABLED=true` — documented Phase 4 mailbox gate (the legacy `MAILBOX_KNOWLEDGE_INGEST_ENABLED` name remains supported)
- `MAILBOX_KNOWLEDGE_INGEST_ENABLED=true`
- `MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED=true` — separate Phase 6 arm switch
- `MAILBOX_KNOWLEDGE_EXTRACTION_BATCH_SIZE` — default 5, bounded 1..50
- `MAILBOX_KNOWLEDGE_EXTRACTION_MAX_ATTEMPTS` — default 6, bounded 1..25

Do not enable Phase 6 in production until the acceptance commands below pass against the exact PR head and the migration is reviewed.

## Acceptance commands

Run from the repository root.

### Focused Phase 6 tests

```bash
pnpm --filter @capiro/api exec jest --runInBand --forceExit \
  src/knowledge/mailbox/mailbox-knowledge-extraction-migration.contract.spec.ts \
  src/knowledge/mailbox/mailbox-knowledge-extraction.consumer.spec.ts \
  src/knowledge/mailbox/mailbox-knowledge-extractor.service.spec.ts \
  src/knowledge/entities/universal-entity-resolution-orchestrator.private-evidence.spec.ts \
  src/knowledge/entities/universal-entity-resolution-orchestrator.service.spec.ts \
  src/knowledge/assertions/knowledge-assertion.service.spec.ts \
  src/knowledge/evidence/knowledge-evidence-validator.service.spec.ts
```

### Full Knowledge Plane regression

```bash
pnpm --filter @capiro/api exec jest --runInBand --forceExit src/knowledge
```

### TypeScript

```bash
pnpm --filter @capiro/api exec tsc --noEmit
```

Compare any failures with the known baseline; Phase 6 files must introduce zero new TypeScript errors.

### Full migration chain

Use a disposable pgvector Postgres database named `capiro`, matching the Phase 5 acceptance environment.

```bash
docker run -d --rm --name capiro-phase6-db \
  -e POSTGRES_USER=capiro \
  -e POSTGRES_PASSWORD=capiro \
  -e POSTGRES_DB=capiro \
  -p 55436:5432 pgvector/pgvector:pg16

DATABASE_URL=postgresql://capiro:capiro@localhost:55436/capiro \
  pnpm --filter @capiro/api exec prisma migrate deploy

pnpm --filter @capiro/api exec prisma generate
```

Then inspect `knowledge_mailbox_extraction_jobs`, its RLS policies, trigger functions, and trigger attachment to `knowledge_mailbox_jobs`.

### Executed validation results

Executed locally on the exact branch checkout after merging the latest `origin/main` (`ac6d93af818330da65fc4969811c86716cdb1cb6`) for conflict-safe validation:

- Focused Phase 6 command: **PASS — 7 suites, 46 tests**.
- Full `src/knowledge` command: **PASS — 51 suites, 253 tests**.
- `pnpm --filter @capiro/api exec prisma generate`: **PASS**.
- `pnpm --filter @capiro/api exec prisma validate`: **PASS** after modeling `KnowledgeMailboxExtractionJob` and its relations in `schema.prisma`.
- Disposable `pgvector/pgvector:pg16` container `capiro-phase6-db`, database `capiro`: full migration chain **PASS**; Phase 6 migration applied.
- Database inspection proved the extraction table, four foreign keys, two duplicate-prevention unique constraints, status/count/hash/scope/lock/result checks, extraction enqueue trigger, forced RLS, tenant policy, and no app DELETE/TRUNCATE grant.
- Trigger rehearsal: a valid incremental/full Phase 4 mailbox row produced one Phase 4 job; marking its valid active event successful produced exactly one Phase 6 job; replaying the same success produced still exactly one. The migration created no historical Phase 6 jobs.
- RLS rehearsal with a non-bypass role: tenant A saw its one row, tenant B saw zero rows, and a cross-tenant update affected zero rows.
- Negative SQL probes: invalid hash/scope, cross-tenant links, duplicate replay, and inactive-event enqueue all failed closed; a 20-minute processing lease was reclaimed with `FOR UPDATE SKIP LOCKED` and the attempt incremented.

The exact requested API TypeScript command still exits nonzero on the repository baseline. A clean `origin/main` checkout with the same workspace builds produced the same unrelated errors (workspace package/type propagation, existing `import.meta`/CommonJS mismatch, and pre-existing Méri/reviews type errors); no Phase 6 file appears in those diagnostics. This remains a documented non-blocking baseline limitation, not a Phase 6 regression.

## Required acceptance cases

- extraction flag off -> no Phase 6 work
- live successful Phase 4 event -> one Phase 6 job, no historical enqueue sweep
- removed/superseded/non-full message -> skip
- event/message revision or hash mismatch -> skip
- immutable event client scope beats later message re-association
- linked client + sender resolution occurs before model extraction
- mailbox identity resolution never invokes external web/model resolver stages
- prompt-injection text remains data
- model cannot inject a canonical ID
- non-verbatim/paraphrased evidence -> held, zero assertion
- resolved canonical subject -> evidence-backed assertion
- ambiguous/unresolved subject -> held, zero assertion
- ambiguous/unresolved entity object -> held, zero assertion
- crash after candidate checkpoint -> retry performs zero additional model extraction calls
- replay -> no duplicate durable assertion/evidence
- cross-tenant/private candidate leakage -> zero

## Validation state at handoff

The implementation was exercised in a runnable authenticated Windows/MSYS checkout. Phase 6 extraction remains disabled by default (`MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED=false` in `.env.example`); no production rollout flag was changed. The GitHub Actions startup_failure currently has zero scheduled jobs and is not treated as code-test validation.

Operational rollout remains: deploy migration/code with extraction OFF; verify queue/worker health; enable only for a tightly controlled tenant/sample; inspect held/asserted ratios and evidence quality; broaden only after review. `drain-mailbox-knowledge` runs Phase 4 first and Phase 6 second only when the separate extraction flag is enabled; there is no scheduler or queue dependency loop.
