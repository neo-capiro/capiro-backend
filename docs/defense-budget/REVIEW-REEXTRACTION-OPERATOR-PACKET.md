# Re-extract a document already awaiting review

## Outcome and boundary

The new `reextract:defense-budget-candidate-v1` command creates a replacement through the existing parser and **production-proof** verifier, while preserving the original REVIEW candidate and original outbox disposition. It closes the missing step before `correct:defense-budget-candidate-v1`; it does not change the REJECT-only replay policy or accept an entire candidate.

Use the existing scoped-review and reviewed-partial-PE-totals surface after examining and linking the replacement. A completed extraction, a human approval, and published data are different milestones. Neither a process exit of zero nor a REVIEW decision means data is published.

## Release requirements

Build the API and ARM64 drain from the reviewed merged source. Apply `20280913010000_governed_review_reextraction` through the normal migration path. The drain Dockerfile asserts that the rebuilt API base contains the command, operation repository, persistence fence and migration; the older partial overlays cannot supply this feature alone.

Use the ordinary app-role connection, not a promoter or database-owner override. Confirm that this role can SELECT/INSERT/UPDATE `budget_reextraction_operation_v1` and perform the already-supported verification writes. Configure the existing absolute `BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT`, `DEFENSE_BUDGET_PARSER_PROJECT_DIR`, versioned extraction bucket, archive/proof settings, environment and actual `GIT_SHA`. The CLI compares `--expected-release-revision` with that runtime SHA; release qualification must independently establish the image's provenance, since an environment string is not image attestation.

Before production use, run the exact packaged command in the isolated ARM64 qualification environment with the real archived source, full production-proof wiring, and the same raw lifecycle cycle for old and replacement candidates. Include a second invocation with the same operation ID, plus the existing correction/scoped-review rehearsal. Confirm exact candidate/run correlation, archive and source metadata, the five headline PE totals, removal of the known 32 misbindings, and no publication before scoped approval. This new image-level gate was **not executed in the implementation workspace**.

## One named operation

Discover the current candidate/run and source hashes using read-only inspection. Do not select a candidate by “latest for source.” The previously reported target was outbox `f57a3419-3d7b-404e-92e4-4932f5e3f524`, candidate `5522ea3b-203f-5eaa-91b2-157422121b66`, raw cycle `cff02efd-45e7-4ae4-8f7f-dacd12bdb84c`. These are historical coordinates, not current-state verification.

Prepare a rationale file, an operation UUID, and the exact old verification-run ID, archived-source SHA and old extraction **content** SHA. Preview is the default:

```bash
pnpm --filter @capiro/api reextract:defense-budget-candidate-v1 -- \
  --env "$TARGET_ENV" \
  --operation-id "$OPERATION_ID" \
  --outbox-row-id "$OUTBOX_ID" \
  --old-candidate-id "$OLD_CANDIDATE_ID" \
  --expected-old-verification-run-id "$OLD_RUN_ID" \
  --expected-source-sha256 "$SOURCE_SHA256" \
  --expected-old-extraction-artifact-sha256 "$OLD_ARTIFACT_CONTENT_SHA256" \
  --expected-release-revision "$RELEASE_SHA" \
  --actor "$REVIEW_OPERATOR" --reason-file "$REASON_FILE"
```

Under the current authorization for this release and exact operation, add `--commit --confirm "$TARGET_ENV"` to the same command. In the drain image use the entrypoint verb `reextract-defense-budget-candidate-v1` with the same flags. Preview performs no archive read, parser execution or database write.

The operation pins the original bindings, source version, runtime settings and release. It uses a stable execution ID and source path, separate work files for each lease, and the proof reader's existing approved root. Verification records its exact candidate/run association in the **same transaction** that persists its evidence. The router checkpoints its terminal output before copying optional local inspection files.

## Recovery and result interpretation

```bash
pnpm --filter @capiro/api reextract:defense-budget-candidate-v1 -- \
  --operation-id "$OPERATION_ID" --status
```

Inspect the recorded status after a waiter/process failure. Reuse the same operation ID and request when resuming the same release. A live claim is busy; an expired or failed claim can resume with a new token. Stale workers cannot commit verification evidence after losing that token. Completed operations return their recorded candidate/run without running the parser again. Intermediate verification correlations remain recorded; they are not automatically treated as the router's final result.

If changed source/review/runtime bindings make an expired operation impossible to resume, close that **named** operation explicitly:

```bash
pnpm --filter @capiro/api reextract:defense-budget-candidate-v1 -- \
  --operation-id "$OPERATION_ID" --abandon-expired --env "$TARGET_ENV" \
  --actor "$REVIEW_OPERATOR" --reason-file "$REASON_FILE"
# After inspecting the preview, add --commit --confirm "$TARGET_ENV".
```

Only failed or expired-running operations are eligible. The closure retains the request, prior findings and correlations and records actor/reason/time. It cannot close a live lease or rewrite a completed result. A later explicitly named operation can then use a repaired release; no SQL state reset is needed.

Exit codes: 0 successful preview/status/closure or completed non-REJECT extraction; 1 execution error; 2 invalid arguments/configuration; 3 refused/busy/conflicting operation; 4 completed extraction with persisted REJECT. Read the decision and findings even when execution completes. `extractionChanged` compares canonical artifact content hashes; it does **not** prove that budget amounts changed. Serialized byte hashes remain separate.

## From replacement to display

Use the exact returned candidate/run to examine the corrected artifact and source pages. A REJECT is retained for diagnosis and cannot be used as a successful correction. For a suitable changed replacement, preview then commit the existing correction command with the explicit old/new pair. This supersedes old scoped decisions transactionally; it does not transfer them. Record fresh scoped approvals only for source-verified PE/FY totals, then verify the existing partial API/UI and citations. Keep unapproved project money out of display. Whole-candidate acceptance, complete-family certification and canonical promotion are not prerequisites for the existing **reviewed partial** surface.

## Implementation validation

The implementation workspace ran orchestration/CLI/reporting/fence tests, existing router/replay regressions, and the new actual-Prisma SQL suite. The SQL run used PostgreSQL compiled to WASM (PGlite) behind its PostgreSQL wire adapter, with 12 tables, 36 indexes and 17 foreign keys generated from the actual Prisma schema, plus the exact new migration. It exercised real transactions, constraints and triggers; it was not a fake Prisma implementation. Its single backend does **not** establish native multi-connection lock scheduling, ARM64 OCR accuracy, all historical migrations, or release-image qualification.

The committed native PostgreSQL gate is:

```bash
# DATABASE_URL must identify an isolated, migrated reextract_test_* schema.
bash apps/api/scripts/test-governed-reextraction-db-v1.sh
```

This suite refuses to run without the explicit integration flag and disposable schema. Never point it at production. The tests cover exact same-cycle claims, immutable input binding, active-source uniqueness, expired-token rejection, rollback of actual candidate/run/proof/check/discrepancy writes, replay correlation, REJECT/no-change reporting, review/source drift, and audited abandonment. Production deployment, re-extraction, correction, approval and publication were not performed by this implementation session.
