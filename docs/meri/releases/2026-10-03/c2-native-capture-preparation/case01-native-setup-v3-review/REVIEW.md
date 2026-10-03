# Dispatcher v3 preparation — not executed

Review target: `../run-case01-native-setup-v3.mjs`. The v1/v2 dispatchers, reviewed inner setup script/rates, and native bootstrap are preserved. No task registration, task execution, cloud read, auth, DB, provider, journal, or repository operation was performed by this preparation.

## Exact scope retained

The v2 release approval and packet checks, both served release snapshots, API source `5b086a6b47ffce5aa1b93bfe38f9c7b96e297642`, API digest `d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd`, inner-script hash `632d00e4…`, reviewed rate hash `3531e09d…`, fixed Pat/T1/Aster/run, four DB secret references, reviewed task-template hash `6c0a447d…`, and registered `taskInput` equality check remain unchanged. Host intents/input/response files are fsynced. No task role, provider credential, fixture mutation, alternate binding owner, or rate is added.

The execution roots retain the existing `case01-native-setup-{plan|execute}-v1` names because no previous version was executed. Their existence still blocks another invocation. Root must run the reviewed v3 file explicitly; this packet performs no operation.

## Evidence and cleanup changes

1. The container wrapper awaits the existing inner module, then emits its complete saved JSONL file with SHA-256, byte/base64 lengths, source/script/rate/run identity, inner exit status, BEGIN/END records, and numbered base64 chunks capped at 8,192 characters. This runs in `finally`, including an inner import/close failure. Missing/oversized receipt or emission failure is explicit and cannot be success. The inner script itself is unchanged.
2. Registration and RunTask dispatch errors are durable, separately named observations. A returned task identity is retained before subsequent assertions. A RunTask acknowledgement failure is never retried; bounded read-only discovery checks only the dedicated family and matches the exact persisted `startedBy` nonce plus task definition. Matching an owned task does not erase the original fatal dispatch error or authorize another action.
3. Stop handling, log collection, deregistration, and final validation are separate guarded phases. A polling failure cannot skip later evidence collection. Stop and deregister each have at most one mutation attempt, each preceded by a durable intent. Cleanup errors are preserved alongside earlier errors, not thrown over them.
4. Every returned CloudWatch page is fsynced in full before parsing, token processing, or assertions. Collection continues through an unchanged forward token, transient read failure, and post-STOPPED ingestion lag. Bounds: a 180-second scheduling window, at most 60 requests, a 32 MiB accepted-page budget (the last received page is preserved before rejecting an overflow), and the existing AWS helper's per-call timeout. An in-flight read can extend beyond the scheduling window by that bounded call timeout. Raw event messages remain available even when the terminal frame never arrives.
5. The host checks exact frame identity, unique/ordered chunks, canonical base64, bytes, SHA, and matching BEGIN/END metadata. It persists `inner-receipt.jsonl` before parsing inner events. A complete failed receipt is retained as evidence; it is not treated as a successful setup. Missing, duplicate, malformed, partial, or mismatched evidence stays uncertain.
6. Final success requires exact inner event sequence/status, no inner/wrapper failure, zero inner/ECS exit, exact owned STOPPED task/image/digest, and independently read-back `INACTIVE` task definition. Any observed mutation-dispatch failure remains fatal even if later receipt/readback shows a committed inner action. `innerObservedStatus` preserves that distinction. Failure never triggers another binding/task run, compensation, or refund.

## Independent review procedure

Verify `checkpoint.json` and `v2-to-v3.diff`. Confirm preserved guard hashes and inspect the wrapper emission, `assembleReceipt`, `collectLogs`, mutation dispatch sites, reconciliation filter, stop/cleanup phases, and final success predicate together. There is exactly one source call site each for register, RunTask, stop, and deregister; only reads repeat. Check that raw task/log responses are saved before relevant assertions and that the final result retains all observations and full receipt path/hash/length.

The new parser validation extracts the exact `assembleReceipt` function without importing the dispatcher. Fourteen offline checks passed for complete multi-chunk transport, empty/partial tails, missing/duplicate/reordered chunks, source/header mismatch, byte/base64 tampering, retained wrapper/inner failures, malformed JSON, and embedded wrapper syntax. `node --check` passed for the full dispatcher. Prior and final offline receipts are preserved separately.

These are parser and syntax checks only. No task/log/cleanup integration was executed and no actual receipt was collected. Root/reviewer must assess the operational control flow before explicit invocation; this checkpoint grants no capture, source, or execution authority.

## Result handling

Use the assembled `inner-receipt.jsonl` plus `result.json`, every raw log page, raw event aggregate, task/definition readbacks, dispatch intents/responses, observations, and external process exit. Only the final matching success status with exit 0 and cleanup confirmation is setup success. All other results require scoped read-only reconciliation; retain the original dispatch failure even if canonical binding or budget installation is later proved committed.
