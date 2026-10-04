# Case14 native canonical owner read — independent source review

## Disposition: FAIL — actionable source findings

Review-only source analysis of `case14-native-read-inner-v1.mjs`, `run-case14-native-owner-read-v1.mjs`, the supplied read-only prerequisites, the prior `continuation-hermes-v1/case14-independent-review/REVIEW.md`, and canonical sources under `C:/dev/main/meri-c1-20261002`. No code was executed; no live AWS, database, provider, or authentication calls were made; no output artifacts or live state are claimed. This is a new bounded canonical owner read design, not a Case20 rerun or fixture write.

### Findings

1. **High — an uncertain `run-task` outcome can leave an untracked live task.**
   `run-case14-native-owner-read-v1.mjs:61-66` persists a `startedBy` and `clientToken`, then calls `awsSingleAttempt(run-task)`. The helper at `aws-single-attempt.mjs:5-16` converts any CLI failure/timeout to an exception without returning a task ARN. In that case `arn` stays unset. The `finally` block at runner lines 118-131 only stops a task when `arn` is known, then can deregister the task definition and report cleanup complete based solely on `!arn` and the definition's inactive status. It never reconciles the persisted `startedBy`/client token against ECS tasks. A task accepted by ECS whose response was lost could therefore keep running while cleanup is reported complete.

   **Required correction:** after any ambiguous launch failure, do not replay `run-task`; reconcile the unique persisted launch identity/task definition against ECS until the outcome is resolved, stop any matching task, and require confirmed `STOPPED` plus definition `INACTIVE` before cleanup success. If reconciliation cannot establish the outcome, report cleanup incomplete/blocked and retain the launch record for manual reconciliation.

2. **Medium — CloudWatch polling can append the same events repeatedly and invalidate a valid receipt.**
   `run-case14-native-owner-read-v1.mjs:87-92` appends every returned event batch before checking whether `nextForwardToken` is unchanged. When the token is unchanged, it breaks only the inner pagination loop; if no END/FAILURE receipt is yet visible, the outer loop polls again with the same token and appends the same events again. The later exact receipt-count/index checks at lines 94-107 can then fail on a valid, eventually complete BEGIN/CHUNK/END stream (and the 5,000-event limit can be hit by duplicates).

   **Required correction:** retain/deduplicate events across polling rounds using stable CloudWatch event identity or only append newly advanced token pages; unchanged-token responses must not be appended again. Preserve ordering and still verify chunk indices, byte count, and SHA-256 before accepting the reconstructed result.

3. **Medium — the runner does not carry forward and compare the complete current governance flag set.**
   At `run-case14-native-owner-read-v1.mjs:33-35`, it copies only `MERI_SYNTHETIC_FIXTURE_NAMESPACE`, `MEMORY_CLIENT_REVIEW`, `MEMORY_GOVERNANCE_LIFECYCLE`, and `MEMORY_GOVERNANCE_ENFORCE` from the live task definition. The supplied task-definition input also contains `MEMORY_GOVERNANCE_CENTER`, but the runner neither refreshes nor asserts it against the current API task definition. It can therefore register a task whose center flag is stale relative to the live service, contrary to the stated requirement to retain the same current governance flags. The canonical review-surface parser in `apps/api/src/memory/memory-review-switch.ts:13-18` confirms the three review switches are necessary, but does not make the omitted center value equal to current configuration.

   **Required correction:** derive and compare the complete agreed governance flag set from the verified live task definition before registration, including `MEMORY_GOVERNANCE_CENTER` when it is part of that set; fail closed on missing or mismatched values. Keep the exact review-surface checks.

### Source checks that passed

- The inner wrapper uses the exact Priya/T1/ASTER scope from the prerequisites and checks one active membership with exact `user_admin` role and Clerk ID before classifying operation absence (`case14-native-read-inner-v1.mjs:5, 20-24`).
- It distinguishes absent operation key from present incomplete/other status, calls the canonical `readCase14FixtureEvidenceInTx` with candidate argument omitted, and treats null for a completed operation as unresolved rather than absence (`inner:22-37`). This agrees with canonical wrapper/owner guards (`case14-fixture-evidence.ts:157-174`; `case14-memory-owner.mjs:22-50`) and the prior independent review's null semantics.
- Review switches are checked by the canonical compiled helper; the runner preserves the selected switch values from the live task definition. The compiled `require('./dist/...')` paths and `./scripts/lib/pe-compose-database-url.js` are expressed relative to the inline module's API working directory, consistent with the API working-directory paths documented in the prior review. This is a source-path assessment, not proof of the image's runtime working directory.
- The result is explicitly projected through an allowlist and excludes owner `text`, settings JSON, recipe/locator content, and credentials (`inner:31-34`). One field, `approvalBasis`, is included; the prior review's narrow output contract did not explicitly list it. Confirm it is a fixed non-sensitive enum or omit it to keep the emitted shape strictly within the documented allowlist.
- Success/absence results throw the rollback sentinel inside the scoped callback and require its identity outside (`inner:16-42`); query/read failures reject the callback rather than producing a successful receipt. The sentinel design is consistent with the canonical owner's lock-taking reads and the prior review's rollback requirement. Actual database rollback remains unverified.
- The registration template drops the workload task role, checks only the four DB secret names, pins the requested immutable API image, and launches one task without a retry (`runner:20-25, 47-65`). The source has explicit stop/deregister cleanup for known task ARNs. These checks do not cure the uncertain-launch reconciliation finding above.

## Limits

No syntax checks, local rollback/output tests, task launch, live source/image attestation, source receipt, task stop, deregistration, or journal comparison was performed here. Do not interpret this review as live evidence, fixture presence/absence, approval, acceptance, or authorization to run. The lead's independent checks remain necessary after the findings are addressed.

## Sources reviewed

- `C:/dev/main/outputs/meri-c2-20261003/case14-native-read-inner-v1.mjs`
- `C:/dev/main/outputs/meri-c2-20261003/run-case14-native-owner-read-v1.mjs`
- `C:/dev/main/outputs/meri-c2-20261003/case14-native-readonly-prerequisites-v1.json`
- `C:/dev/main/outputs/meri-c2-20261003/continuation-hermes-v1/case14-independent-review/REVIEW.md`
- `C:/dev/main/meri-c1-20261002/apps/api/src/memory/case14-fixture-evidence.ts`
- `C:/dev/main/meri-c1-20261002/apps/api/src/memory/case14-reviewer-preflight.ts`
- `C:/dev/main/meri-c1-20261002/apps/api/src/memory/memory-review-switch.ts`
- `C:/dev/main/meri-c1-20261002/evals/meri/live-v1/fixture-provisioning/case14-memory-owner.mjs`
- `C:/dev/main/outputs/meri-c2-20261003/corpus-read-definition-input.json`
- `C:/dev/main/outputs/meri-c2-20261003/aws-single-attempt.mjs`

No implementation changes were made.