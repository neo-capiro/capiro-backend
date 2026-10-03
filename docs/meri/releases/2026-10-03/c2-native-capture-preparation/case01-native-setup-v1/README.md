# Prepared case01 binding and budget operator

Status: **PREPARED, NOT EXECUTED**. This packet contains no DB result, image/deployment qualification, admission, spend reservation, model call, or benchmark acceptance.

The inner operator is pinned to source `5b086a6b47ffce5aa1b93bfe38f9c7b96e297642`, existing Pat/T1/Aster, case01, and prospective run `bd35c0f4-1604-4371-b7e9-a1338369e53f`. The real actor/membership/client/wall/source checks still run in the existing owners. The reviewed rate file is fixed by both its byte hash and the production `captureBudgetHash`; its expiry is not extended. Limits are exactly $15, 500,000 total tokens, and 32 attempts. Unsupported provider kinds remain unpriced and rejected.

## Independent review instructions

1. Verify every file hash in `preparation-checkpoint.json`. Compare the source reconstruction at `sourceAuthority.qualifyInTx` with the already reviewed `../case01-canonical-bind-plan-inner.mjs`: inventory is explicitly not capture authority; actual previous/current runtime hydration and qualification run inside each binding-owner transaction. There is no caller-supplied proof, fixture ID list, alternate scope, semantic date, ready flag, reviewer, or provider client.
2. Inspect the only mutation calls: `owner.bind(...)` and `installCaptureProviderBudgetQualification(...)`. Binding must pass prior binding hash, tenant xmin, and current canonical verify hash. Budget install must pass current verify, capture binding, prior qualification, and tenant xmin. Before execution, the entire freshly rebuilt plan must match the reviewed plan and hash. A previously bound target run is refused, including a partial prior execution.
3. Check the pinned rate bytes, semantic hash, existing production validators, exact limits, and real-time 30-minute remaining validity check before DB access and again before budget installation. This does not change native model/configuration or qualify Typesafe JEV/NVIDIA billing.
4. Check stage JSONL: a new receipt path is claimed before DB access; every event is fsynced; each mutation has a preceding intent and following receipt. Binding and budget installation are **separate existing transactions**. A later failure may leave binding committed. There is no automatic retry, rollback claim, compensation, rebind-to-old-run, or resume path. The outer operator must preserve stdout, receipt bytes, task identity, exit status, and its own durable dispatch claim. An uncertain result needs read-only reconciliation before another reviewed action.
5. Verify that the only composition-owned SQL is SELECT and that no seed, retire, approve, withdraw, reset, locator install, conversation creation, provider, scheduler, journal, or capture API is invoked. Final readback compares all tenant settings outside `captureEvidence` and `captureProviderBudget`, including locator/setup claims/history, with the before hash.
6. This was syntax-checked only. No new fake DB/provider tests establish runtime qualification. Existing binding/budget owner tests and the reviewed canonical read composition are the reused authority. Require immutable-image runtime/module qualification and a real read-only plan before any explicit execution.

## Required external preflight

Root must first qualify the new immutable API/orchestrator images and served releases, current governance cohort/configuration, provider wire guards, and reviewed rates. Pin the task to the approved API digest; `RELEASE_SHA` equality inside this script alone cannot establish the actual digest or the deployed orchestrator. Keep all credentials in the already authorized runtime configuration; none belong in the input or receipt. Do not add a task role, provider key, new endpoint, generic DB operation, or deployment to run this preparation.

Use the existing qualified API operator task composition and one-shot dispatch discipline. The inner script imports fixed `/app` modules and composes DATABASE_URL through the existing helper; it must run inside that image, never directly on the workstation. No AWS launcher is supplied here.

Stage these exact prepared bytes as `/app/apps/api/case01-native-setup-inner.mjs` and `/dev/shm/case01-reviewed-rates-v2.json`. Set `MERI_C2_CASE01_SETUP_INPUT` to the contents of `plan-input.json`. Existing runtime namespace/governance/DB configuration must remain unchanged. The read-only command is:

```sh
node /app/apps/api/case01-native-setup-inner.mjs plan --out /dev/shm/case01-native-setup-plan-01.jsonl
```

Retain the full JSONL and exit code. The final `phase: RESULT`, `status: PLAN_ONLY` event contains `plan` and `planSha256`; review both. Build a separate execute input with exactly these keys:

```json
{
  "confirmation": "BIND_EXISTING_CASE01_AND_INSTALL_BOUNDED_BUDGET_ONCE",
  "expectedSourceSha": "5b086a6b47ffce5aa1b93bfe38f9c7b96e297642",
  "plan": "REPLACE_WITH_EXACT_OBJECT_FROM_THE_SUCCESSFUL_CURRENT_PLAN",
  "planSha256": "REPLACE_WITH_EXACT_CURRENT_PLAN_HASH"
}
```

Those placeholders are intentionally invalid. After root reviews the actual plan and explicitly invokes the approved operation, set the input environment variable to that exact execute input and use a new receipt path:

```sh
node /app/apps/api/case01-native-setup-inner.mjs execute --out /dev/shm/case01-native-setup-execute-01.jsonl
```

Only `BOUND_AND_BUDGET_READ_BACK` plus a successful exit is setup success. Its receipt remains `liveAcceptance: NOT_RUN`. Fresh source/tenant changes reject the old plan. Do not overwrite old evidence or create a new plan to bypass an uncertain write.

## Native capture ordering and remaining bootstrap gap

This setup ends before any conversation or spend reservation. The existing same-process native path is `prepareCase01LiveCapture({config,runRoot,artifactStorage,spendReservation,env})` followed by `executeCase01LiveCapture(capability)`. It requires a fresh precreated ordinary conversation, exact source/fixture mapping from current proof, the authenticated actor, actual immutable build/served admission checks, and the native aggregate reservation capability. It cannot be replaced with arbitrary settled JSON or a synthetic-read-budget capture.

For the later native bootstrap: preserve the actual 20-event fresh journal and its existing authorization; open its supported aggregate checkpoint, reserve the case01 $15 ceiling in the same process, then create one ordinary owned conversation, construct the actual case01 config, and call the native prepare/execute pair in that process. Preserve concurrency one and any unresolved historical costs. This prepared script never reads or writes that journal, including initialization or reservation.

`run-controlled-read.mjs` currently supports only 20/72. `case01-execution-setup.mjs` invokes seed/retire and is prohibited for this existing corpus. `capture-cli.mjs` calls the generic adapter, generates another run UUID, and does not supply the native aggregate capability; it is not the missing case01 bootstrap. A separate bounded root integration of the existing native case01 APIs remains required. Do not run the generic CLI as a workaround.

## Source references

- `evals/meri/live-v1/fixture-provisioning/capture-binding-owner.mjs`: transaction, actor/wall/current-source validation, binding CAS.
- `evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs`: strict original locator/corpus verification; hydrated budget authority requires an already current binding.
- `evals/meri/live-v1/fixture-provisioning/case01-memory-runtime.mjs`: actual hydrate/qualify owner; no lifecycle mutation called here.
- `apps/api/scripts/meri-case01-setup-dependencies.mjs`: fixed actual service composition, tenant context, current standard actor validation.
- `apps/api/src/meri/meri-capture-provider-budget-install.ts`: current plan/install protocol and exact four fences.
- `apps/api/src/meri/meri-capture-provider-budget.ts`: actual qualification limits and stable evidence hash.
- `evals/meri/live-v1/case01-live-capture.mjs`: native admission and same-process spend capability.
- `evals/meri/live-v1/capture-spend-aggregate.mjs`: existing fresh journal adoption/reservation owner; not invoked by setup.

The old provider-budget Markdown contains obsolete $3/no-aggregate prose. This preparation follows the current source contracts and reviewed $15/$30 authorization, not that stale prose.
