# Original 75-case benchmark: first attempted turn

The original benchmark is **incomplete**. One original case was submitted on
2026-10-02 at 17:49 UTC. Case01 produced no answer. No other original row gained
full acceptance from this attempt; the earlier case17 UI slice remains a separate
partial result. The six owner-account spot checks are not substitutions for these
75 cases.

The collector reported `CAPTURE_UNCERTAIN / CASE01_RESPONSE_REJECTED` because it
did not retain the HTTP failure details. Independently scoped API507 logs show
`meri_capture_provider_budget_unqualified_retrieval_plan`, followed by a terminal
error after203ms. An authenticated readback from the same owned conversation,
verified against the API release header, found an admitted provider ledger with
zero attempts, zero charged tokens/cost, null turn ID and zero saved messages.
The temporary synthetic sessions were revoked. This reconciles the absence of
an answer; it does not turn the case into a pass.

Current runtime: API507/source42988dae5fb7bc2fff3af582ca15a0836a4477c5;
orchestrator99/sourceddb55a5a3e6bbf1c3f567119b66e18e0a92e60ab;
WebVNext388/source78ad5805679a3045b1fc10fb19beafa7f76e4e64.
See the [completed deployment, migration and owner QA evidence](../live-response-and-mail-repair/live-verification/README.md).

At this checkpoint, the sole aggregate journal still holds the full$3 reservation
for original01. The remaining pool is$27, concurrency1. An append-only terminal
reconciliation is being prepared; do not reset the journal, reuse this claim,
reseed over uncertain rows or resubmit this request. Any later retest needs a
distinct, properly prepared run after the defect is fixed.

The [75-row readiness map](oct02-original-eval/original75-readiness-20261002.md)
records the executable paths and missing fixture/capture work. All75 definitions
passed contract validation; this is not75 live executions. Six native capture
paths and15 deterministic row predicates exist. The original contract permits a
shared authenticated API/browser evidence protocol; per-case wrappers and the
current numeric$3/$30 ceilings are implementation choices, not original benchmark
requirements. Current limits remain in force while that shared path is prepared.
Human adjudication remains outstanding and must not be represented by model scores.

The source-only owner QA diagnosis also records the unrelated remaining task
result-contract failure and mail-request legislative misclassification. No fixes
for those findings are asserted in this archive.

The16 files in `index.json` were copied byte-for-byte and verified bySHA256.
Private fixture manifests, auth tokens, session state and journal capabilities are
excluded. Readback source is archived as `.mjs.txt`, not a deployment entrypoint.
Shared policy:743fd708c3484604e8a35ea1039adeca3b1e331f; machine map2026-09-30.
