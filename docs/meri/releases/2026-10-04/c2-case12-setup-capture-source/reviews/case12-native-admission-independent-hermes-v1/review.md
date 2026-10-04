# Independent review: frozen root native ECS setup admission

## Disposition

CONCRETE FINDING — source/image authority is not bound through the durable setup owner’s frozen plan. The native ECS checks establish that the running task and task definition match the supplied budget plan; the durable owner does not establish that the budget plan’s `sourceSha256` or `imageSha256` are the values approved by its frozen setup snapshot. This is a source-level binding gap, not evidence of a live task or an external integration failure.

This review is limited to the frozen files in this evidence bundle. It grants no live, capture, dispatch, or shipping authority. The separately mandatory Windows native hold/census/dispatch composition is absent here and remains required; a compact packet is not setup authorization.

## Concrete finding

**F-1 — Budget source/image digests are accepted without binding to the durable owner snapshot.**

In `source/meri-case12-native-setup-admission.ts:79-82`, the envelope is compared with the supplied budget plan for run/reservation/fixture IDs, `setupPlanSha256`, provider-plan hash, and checkpoint hash. The source and image digests are only shape-checked by the budget validator. The ECS task image and definition image are then checked against `plan.imageSha256` (`:104`, `:117`, `:119`), and the receipt copies `plan.sourceSha256` (`:123-125`). Those checks prove consistency with the supplied plan, not approval of those two values by the durable setup recipe.

The durable owner does validate the full frozen recipe/plan hashes and ordered candidates in `dependencies/meri-case12-setup-budget-owner.ts:124-164`. But `validateAdmittedPlan` (`:166-177`) cross-checks the admitted budget’s setup/recipe/ordered-definition hashes, tenant/fixture/actors/client, and candidate row IDs/logical IDs/payload hashes; it does not compare `plan.sourceSha256` or `plan.imageSha256` with a corresponding value in the frozen plan/recipe. The native port therefore cannot be treated as supplying those missing owner checks.

**Exact source-level reproduction:** hold the owner bindings’ `planSha256`, `recipeSha256`, `orderedDefinitionSha256`, and candidate rows fixed. Supply an otherwise-valid budget plan with the same `setupPlanSha256` and those same owner-bound fields, but replace `sourceSha256` with any other 64-character lowercase hex digest and `imageSha256` with another valid digest. Configure the native envelope and the controlled ECS task/definition/metadata image fields consistently with that replacement image. The budget validator accepts both digests by shape; native admission checks the replacement image against ECS and copies the replacement source digest; `validateAdmittedPlan` has no comparison rejecting either substitution. This can be exercised with the existing controlled ECS/metadata doubles; it does not require or imply a real ECS task. The exact missing checks are the absent source/image comparisons in `validateAdmittedPlan`, not a claim that an attacker can alter an already-registered live task.

**Required correction before treating this source as qualified:** explicitly bind each admitted source/image digest to the intended frozen owner evidence (or remove the claim/field if it is not an owner-approved value), and add negative tests which mutate each digest independently while keeping all existing owner-bound hashes/rows fixed. Revalidate through the owner composition, not just the native port.

## Checks that pass at source level

- **Fixed link-local metadata endpoint:** `metadata()` accepts only HTTP at hostname `169.254.170.2`, no explicit port/credentials/query/fragment, and a constrained `/v4/<token>` path (`source/...ts:43-51`). It requests the local task endpoint with a timeout and redirect rejection, and bounds response bytes. It does not accept an operator-provided metadata URL.
- **Native ECS identity and task/definition evidence:** the code uses a fixed account, region, and cluster; requests one task by the metadata-derived ARN with tags and requests the exact task definition with tags. It requires the task ARN/cluster/definition/startedBy, Fargate and running status, family group, one matching owner marker, one expected container, and matching image digest. It checks an ACTIVE exact-ARN task definition, definition hash/configuration, matching definition owner marker, container image/name, and restart policy. Metadata task/container identity and image are cross-checked too (`:85-121`).
- **Raw input and override binding:** process environment must equal the exact raw input string; the ECS task override is hash-compared to the expected sole container/environment override, with the serialized expected override size capped (`:59-60`, `:71-76`, `:105-108`). A generic packet or provider plan by itself is not admitted. The native envelope has an exact key set and guards every non-discriminator/version value as a string before using it (`:63-78`).
- **Task-definition configuration hash:** the hash projection covers the listed task-definition execution/configuration fields (`:24-32`); service-generated revision/status/date fields are checked separately by exact ARN/status and metadata revision binding. The image digest is separately checked as above.
- **Opaque one-use closure and timing:** the returned admission capability is an object identity held in closure state. Consumption checks identity and flips `consumed` synchronously before its first `await` (`:126-135`), so invalid bindings or concurrent/repeated calls cannot reuse the capability. Process time bounds native observation latency; the durable consume independently uses database `clock_timestamp()` under tenant-row lock and checks the admission window (`:136-140`).
- **Locked durable admission and replay denial:** consumption locks the fixed tenant row, checks namespace and absent competing admission/setup slots, then performs a conditional JSONB update and verifies the returned receipt (`:136-146`). The one-use in-memory handle denies retry after a failed consume. The durable owner separately locks and CAS-writes its budget slot, and validates the admitted budget against the frozen recipe/plan/ordered candidates (`dependencies/meri-case12-setup-budget-owner.ts:226-245`, `:263-287`).
- **Rollback/error propagation:** the native consume path does not catch errors after the durable update/readback; failures propagate to its caller. The budget owner also lets admission/initial-budget failures escape `consumeCase12SetupSpendAuthority`. Real transaction rollback is not established by these source files or SQL doubles and must be verified with the actual transaction composition. Do not infer atomicity from mocked query results.
- **Provider composition:** the inspected provider scope uses closure capabilities, consumes settlement state before awaiting, and blocks retry after uncertain/failed writes. The budget owner serializes rows, reserves before dispatch, persists settlement, and requires terminal-row proof and exact returned bindings before completion. These are source observations, not qualification of real provider/database behavior.

## Evidence and limitations

- `evidence/tests-v2.log` records 1 suite and 29 tests passing. The spec uses controlled `fetch`, mocked ECS SDK commands, and an in-memory SQL double; the passing tests cover fixed native reads, mutation denials, one-use consumption, and wrong-type envelope values. These results are recorded evidence, not a fresh test run in this file-only review.
- The manifest says actual DB/default transaction behavior, IAM/ECS task qualification, and CLI/wiring were NOT_RUN. No real ECS, IAM, database, provider, or transaction rollback calls were made for this review.
- `evidence/prior-qualification/case12-native-admission-typecheck-v2.log` is empty (0 bytes); it is not evidence of a current successful full API typecheck. The manifest says the prior full API typecheck v2 preceded the strict delta and that a new full typecheck is pending. The older v1 log contains TS2783 duplicate-property errors; do not treat that old result as the current source’s typecheck.
- No CLI or active route wiring is in the evidence bundle. Native admission source alone does not qualify the Windows hold/census/dispatch operator composition.
- Scope was source-only and file-only. No source files were modified.

## Reviewed evidence files

- `evidence/source/meri-case12-native-setup-admission.ts`
- `evidence/source/meri-case12-native-setup-admission.spec.ts`
- `evidence/dependencies/meri-case12-setup-budget-owner.ts`
- `evidence/dependencies/meri-case12-setup-budget.ts`
- `evidence/dependencies/meri-case12-setup-provider-scope.ts`
- `evidence/tests-v2.log`
- `evidence/prior-qualification/case12-native-admission-typecheck-v2.log`
- `evidence/prior-qualification/case12-native-admission-typecheck-v1.log`
- `evidence/manifest.json`

This is a source review only. It is not approval, admission evidence for a live task, permission to dispatch, or a release decision.
