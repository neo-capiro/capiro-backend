# Memory candidate source-kind compatibility assessment

Status: source diagnosis confirmed; live constraint/state readback is owned by CD/root and was still pending at this assessment. No source, schema, migration ledger, provider, fixture, or cloud edits were performed here. The separate formatting branch remains clean at f72747b3a62c17bee07f47df8a6182d89290cb60; its memory/schema blobs are unchanged from live API source a260004e9923ef5bbe7bd8f32bb4cbddd3c7be31.

## Recommendation

After actual live definition confirmation, add a NEW forward migration that permits the three canonical immutable-version kinds alongside the existing six. Do not relabel memory_correction/restore/contradiction to explicit_user or learning_signal, and do not edit an already applied migration or shared migration ledger.

Canonical evidence:
- apps/api/src/memory/immutable-memory-version.service.ts:35 declares the three kinds; insertCandidate around808 persists them with typed source/payload/provenance; lockCandidate around855 requires them; approval around249 asserts the source kind matches the typed payload.
- apps/api/src/memory/memory-version.helpers.ts:62 maps these exact values to correction/restore/contradiction. memory-candidate-review.service.ts:285 dispatches those kinds to ImmutableMemoryVersionService; standard kinds take the ordinary candidate approval path. Remapping changes semantics and defeats the intended immutable version route.
- settings-memory-version-candidate.service.ts:117 independently writes memory_correction for Settings correction proposals. This is a product contract, not an eval-only invented value.
- 20260812010000_memory_immutable_versions installs dedicated payload, reviewed target-lineage, and immutable approval guards conditional on these exact kinds/surfaces.
- 20260818010000_memory_phase2_review_workflow_foundation maps all three into review-workflow kinds in SQL.

Migration history is four allowed kinds in20260712020000, then five in20260818030000, then six in20261213010000. No checked-in source-kind allowlist ever admitted the three immutable kinds; this is not evidence that the last migration removed three previously permitted kinds.

## Guard and test requirements

Use the actual current source-kind constraint definition/validation state from the read-only live probe. Preserve all six current kinds, varchar24/NOTNULL, RLS, tenant/current-user guards, review assignment, immutable target checks, and all unique constraints/triggers. Reject unknown additional kinds.

Also inspect the existing version payload check. Its source expression uses nullable JSON predicates without IS TRUE. Missing versionProposal can evaluate to SQL NULL, which PostgreSQL CHECK accepts. Do not claim a malformed/missing payload negative passes without testing it. If reproduced, the narrowly relevant repair is to require the existing version-payload predicate to evaluate TRUE for the newly admitted kinds, preserving the intended kind/source/target requirements. This observation is a source/SQL-semantics finding, not yet a live data assertion.

Prior lifecycle PG tests are real canonical service executions against a simplified rollback schema. approved-memory-schema.mjs:14 has source_kind text and no source-kind CHECK; approved-memory-postgres-harness.mjs creates that schema. These tests did not qualify this production constraint. New tests must execute the exact historical guard(s) and proposed migration, then run canonical correction/restore/contradiction writes/approval, preserve old six kinds, reject unknown kinds and malformed payloads, and prove tenant/immutable guards remain effective. Include one negative that fails before repair and passes after without changing candidate kind.

## Migration / release implications

- The migration SQL must be LF-exact and ordered after the current latest source entry20281004040000. Current449 migration SQL bytes remain immutable; new count450.
- Current API image recipe is intentionally hardpinned449 and markerEXACT_449_IMAGE_MIGRATION_HASHES_PASS. A NEW versioned recipe/input/qualification must assert450 and exact450 source-to-image hashes. Preserve previous449 receipts; never relabel them as450.
- Current live API505 qualified schemaChange:false. A release containing this migration must classify schemaChange:true and supply current freshDatabase, retiredUpgrade and compatibility evidence required by scripts/lib/meri-release-policy.mjs:136.
- Additive admission of canonical kinds is compatible with the existing API code that already writes/reads these kinds. Image rollback must leave the widened constraint in place once any such rows exist; narrowing back to six would fail or strand the same feature. No automatic destructive down-migration.
- Avoid an unbounded ALTER scan/lock during the recent database incident. A CHECK replacement takes strong table locks; use an explicit bounded transaction/lock timeout and size-aware validation plan. NOT VALID plus later VALIDATE reduces validation locking but introduces an intermediate state that must be explicitly tracked; it is not automatically the correct recipe. Root chooses the execution form after table/constraint readback.
- Do not run a broad pending-history migrate sweep solely for this fix. The older shared-ledger divergence/open failure is a separate known condition; ordinary ledger rewrites/resolution are not authorized. Bind any approved targeted forward execution to its exact committed SQL and record actual schema readback.
- Current original01 has verified first projection and failed PREVIOUS_SEED. A schema repair does not authorize restarting/reapproving from scratch; root must use current exact-state guarded continuation/resume and preserve prior claims/projection receipts.

SQL semantics reference: PostgreSQL16 Constraints https://www.postgresql.org/docs/16/ddl-constraints.html confirms NULL satisfies CHECK. ALTER TABLE https://www.postgresql.org/docs/current/sql-altertable.html explains validation scans and weaker VALIDATE locking. These sources support the SQL analysis; no production SQL was executed by this lane.