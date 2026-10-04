# Case14 native canonical owner read — source review

## Disposition: PASS — requested source corrections are present

Reviewed the updated `C:/dev/main/outputs/meri-c2-20261003/run-case14-native-owner-read-v1.mjs` and the unchanged `C:/dev/main/outputs/meri-c2-20261003/case14-native-read-inner-v1.mjs`. This is a bounded source review only. No code was executed and no cloud, authentication, database, provider, or journal calls were made. No source files were changed.

### Verified corrections

- **Ambiguous RunTask outcomes fail closed and are reconciled without retry.** The runner persists the unique `startedBy` and `clientToken` in `task-input.private.json` before dispatch (`run-case14-native-owner-read-v1.mjs:62-67`). If dispatch returns without a task ARN, cleanup performs up to six read-only discovery attempts, listing the exact task-definition family for RUNNING and STOPPED tasks and matching both `startedBy` and exact task-definition ARN (`:120-138`). It does not retry `run-task`. A matching task is recorded and stopped if needed; cleanup requires it to reach STOPPED (`:141-145, 151-154`). If discovery is inconclusive, it records `RECONCILE_RUN_TASK`, makes cleanup incomplete, and retains the launch input/reconciliation records for follow-up (`:134-138, 152-154`). An ambiguous registration similarly forces incomplete cleanup when no definition ARN was obtained (`:140, 151-154`).
- **CloudWatch event accumulation is deduplicated across polling rounds.** Events are keyed by timestamp, ingestion time, and message before being appended (`:77, 92`). The subsequent receipt checks still require exactly one BEGIN and END, complete ordered chunk indices, matching byte count, and matching SHA-256 (`:105-109`).
- **The current governance flag set includes `MEMORY_GOVERNANCE_CENTER`.** The runner requires all five named flags to exist in the live API task definition and copies their current values into the one-off definition (`:26-35`), including the center flag. The synthetic fixture namespace is also checked against the expected value (`:35`).
- **Inner read remains constrained and non-authoritative.** It verifies the exact active member/role/Clerk identity before examining the operation (`case14-native-read-inner-v1.mjs:20-24`), distinguishes absence from present-but-incomplete or unresolved state (`:22-37`), calls the canonical owner reader, and throws the rollback sentinel before returning (`:26-42`). Output is projected through explicit owner/item/decision allowlists (`:31-34`); `approvalBasis` is included as the source-owned fixed field, not as serialized user text or settings. The result explicitly reports rollback and no acceptance authority (`:25, 42, 57-60`).

### Remaining limits / accepted behavior

- Launch reconciliation is deliberately bounded. If no exact task is discoverable within the six attempts, the runner does not claim cleanup success; it leaves cleanup incomplete for manual reconciliation. This is a safe blocked outcome, not evidence that a task was absent.
- An ambiguous task-definition registration is likewise surfaced as cleanup incomplete rather than silently treated as cleaned up.
- The source's expected live flags are presence-checked and copied from the described current task definition; this review did not independently query AWS or validate live values.
- No runtime, local tests, live read, transaction rollback, output receipt, task cleanup, journal comparison, or operational success was verified here. PASS applies only to the reviewed source corrections and read-path constraints; it is not live evidence, fixture classification, approval, or authorization to run.

## Sources reviewed

- `C:/dev/main/outputs/meri-c2-20261003/run-case14-native-owner-read-v1.mjs`
- `C:/dev/main/outputs/meri-c2-20261003/case14-native-read-inner-v1.mjs`
- `C:/dev/main/outputs/meri-c2-20261003/case14-native-read-hermes-review-v1/REVIEW.md` (prior findings for comparison)

No concrete remaining source blocker was identified within the requested review scope.
