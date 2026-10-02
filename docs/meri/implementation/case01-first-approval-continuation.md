# Case01 first-approval continuation

This operator is limited to the first pending candidate of an existing case01
setup whose original setup and first recovery both remain `STARTED`. It does not
reset either operation, resume later stages, or admit a second continuation.
The October 2 failure was reproduced with real Prisma against `tenant_role`:
the bound text comparison failed with PostgreSQL `42883`. The guarded approval
and retirement queries now cast the enum column to text. The read-only live
diagnosis must be reconciled before the release operator chooses to continue.

Use the existing fixed image command `meri-case01-setup` with `continue-plan` or
`continue-execute`; there is no new route or permission. The same strict
`--input ABS_JSON` or `--input-env MERI_CASE01_SETUP_INPUT`, plus `--out ABS_NEW_JSONL`,
input and output rules apply. Input is:

```json
{
  "recipe": "the unchanged original recipe object",
  "expected": {
    "originalClaimSha256": "hash from current authoritative readback",
    "recoveryClaimSha256": "hash from current authoritative readback",
    "candidateRowVersion": "current exact pending candidate xmin"
  },
  "expectedPlanSha256": "required only for continue-execute; from the fresh plan"
}
```

The placeholder strings above are not executable input. The plan locks and reads
the actual tenant, memberships, reviewer authority, candidate, source identity,
and existing claims. It rejects any changed payload, item, legacy projection,
audit, binding, locator, owned conversation, or previous continuation. The plan
binds the current tenant row version and complete settings hash.

Execution repeats that inspection, compares the exact plan, then atomically
claims `meriFoundationFixture.case01ExecutionSetupContinuation` against the
current tenant version and settings. The original two claim objects are kept
byte-equivalent as JSONB. The canonical first approval receives the admitted
candidate version and guard again; the normal setup owner then seeds, retires,
replaces, binds, installs its restart locator, and creates the empty conversation.
Final completion also compares both historical claims and the continuation
claim. A partial failure remains `STARTED`; no retry or claim clearing is allowed.

Structured stdout uses the existing `MERI_CASE01_SETUP_RECEIPT ` prefix. The new
admission stage is `CONTINUATION_ADMISSION`; first approval and all later stages
keep their existing names. Plan kind is
`meri-case01-first-approval-continuation-plan`; final receipt remains
`meri-case01-execution-setup-receipt`, with `liveAcceptance: NOT_RUN` and zero
synthesis submissions. Budget installation and the single original evaluation
turn remain separate root-operated steps after authoritative setup completion.
