# Case01 setup dispatcher v4 — preparation only

Review `../run-case01-native-setup-v4.mjs` and `../case01-native-setup-v4-definition.mjs` against the unchanged v3 dispatcher. Do not execute or import the dispatcher during review.

The retained plan-v1 definition was registered and deregistered, but its strict input comparison failed before RunTask input creation. Root's independently saved reconciliation is pinned by byte hash in v4, together with the old result and v3 source fingerprints. This preparation does not itself establish fresh cloud state or authorize execution.

V4 uses new exclusive `case01-native-setup-plan-v2` / `case01-native-setup-execute-v2` directories. Execute reads only the successful plan-v2 result. Old run directories and v1/v2/v3 dispatcher files are untouched.

The definition receives exactly seven absent ECS defaults before registration: top-level volumes and placementConstraints empty arrays, container cpu zero and portMappings, mountPoints, volumesFrom, systemControls empty arrays. Explicit existing values, including null or nondefaults, are preserved. The pure comparison helper only sorts environment rows by unique name, retaining full row shape and value. It rejects duplicate names and malformed/missing environment arrays. All other field values and array orders remain significant. Registered readback is not default-filled; an actually missing field still fails comparison. The helper's bytes are pinned before any cloud action.

Inner script, API source/image, rates, template bytes, four secret names, one-shot dispatch, receipt transport, failure retention, stop/deregister and INACTIVE cleanup requirements remain unchanged. The diff is limited to helper import/hash, explicit definition defaults, normalized environment comparison, new directories, and prior-failure reconciliation pin.

Offline validation:

- The exact old submitted/readback fingerprint comparison fails as expected; final-source red receipt is retained.
- 41 final normalization tests pass using the actual saved task definitions and negative mutations. Tests cover image, command/entryPoint/container/secret order, roles, capacity, all defaults, secret reference, environment values/shape/missing/extra/duplicate rows, nulls, unknown fields and source placement of pre-RunTask guards.
- 14 existing exact extracted receipt-assembler and generated-wrapper syntax checks pass on v4.
- Node syntax check passes. Neither dispatcher was imported or executed. No AWS, setup, provider, auth, DB or journal actions occurred.

One intermediate offline run failed because a static test rejected every mention of the old result, including the newly requested reconciliation hash check. The corrected assertion rejects only reuse of the old result as the executable plan. That failed receipt remains alongside the final green receipt.

Limits: these tests prove local comparison and receipt-parser behavior; they do not prove a new ECS registration, RunTask result, CloudWatch receipt delivery or canonical binding. Root owns the fresh live preflight, explicit invocation and reconciliation of any uncertain outcome.
