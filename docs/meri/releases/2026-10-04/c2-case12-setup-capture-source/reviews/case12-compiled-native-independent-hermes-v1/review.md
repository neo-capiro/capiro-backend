# Independent review — Case12 compiled native local composition

Disposition: PASS_COMPILED_RESTORED_LOCAL_COMPOSITION_WITH_LIMITATIONS

Scope: file-only review of the frozen evidence packet and saved receipts. No database, cloud, provider, journal, native-helper, or test-run actions were taken; no source was edited and no tests were rerun. Private snapshot/config input was not opened, copied, or hashed.

## Evidence basis

The packet’s pin summary records an independent rehash of all 2,296 public artifacts and 125 source plus 2,120 compiled-runtime snapshots against the pre/post-build pins (4,542 public hash checks); private input is excluded. I reviewed the manifest, pin summary, final v3 harness and tests, saved qualification receipts/log, rollback receipt/test, cleanup readback, retained-attempt record and prior reviews. The documented snapshot/build boundaries are consistent with the artifacts inspected here.

The composition harness verifies reviewed source and compiled pins before and after execution, loads the compiled dependency graph, and calls the actual zero-argument `createCase01SetupDependencies()` Nest factory. It does not replace production readers or authorization functions with mocks. It uses a disposable, owned schema and a `SET LOCAL search_path` transaction shim, with transaction defaults left intact (5,000 ms; no timeout override). The composition test uses a compiled eligibility reader explicitly. The local schema is deliberately reduced and complemented for the real readers; this is not a production migration/RLS or load qualification.

## What the final saved evidence establishes

- The final composition receipt is `PASS_COMPILED_NATIVE_RESTORED_LOCAL_COMPOSITION`; its saved Node test log reports 9/9 passing (eight child tests plus parent). The v3 child-check wrapper propagates child failures before later work or writing a qualification. This corrects a real harness defect, not an application-byte change.
- Actual `readCase12Setup` completed as `CURRENT_HYDRATED` on restored local510 data in about 25.12 s across 2,553 default transactions. The final locked inventory transaction is recorded as 644.75 ms / 23 queries. A separate final native inventory/completion check is recorded as 919.81 ms / 23 queries. No per-transaction timeout override is recorded.
- Current native corpus/completion checks observed 510 completed rows and 1,020 provider attempts, with capture authority false. Capture-binding plan/install exercised stale-plan denial, one install and replay denial. Provider-qualification plan/install exercised current-source checks and stale-CAS denial. Native policy issuance, semantic clock, current capture authority and local provider-ledger admit/reserve/settle were also exercised.
- The actual persisted clock-packet census performed both source checks in one default transaction (1,707.18 ms / 51 queries), in addition to its separate factory scope read. Real compiled core HMAC signing/verification and native current MA510 source joins were used for full-read receipt qualification and signed partial-read denial. These are local readback checks, not proof of an actual model/tool exchange.
- The separate native-admission rollback receipt records 6/6 tests including parent (five child cases). Only metadata fetch and ECS SDK `send` are doubled; actual local database transactions exercise JSON-substitute rejection before DB access, outer-transaction rollback, write-readback failure rollback, same-handle concurrent single consumption, and denial when setup already exists. The handle remains consumed when the surrounding transaction rolls back. Receipt records zero AWS network/live-provider calls and preserved setup slots.
- Cleanup readback reports zero remaining owned test schemas, the primary PostgreSQL container untouched, and the exact root-owned pgvector container left for root cleanup. No cleanup was inferred beyond that receipt.

## Failed attempts and disposition integrity

Run-v1’s PASS-labelled composition receipt is invalid: awaited Node child subtests do not make the parent promise reject, so the parent continued after child failures and wrote PASS. The retained disposition explicitly marks it invalid and records process exit 1. Do not use it as qualification. Run-v2 failed on the disposable schema and wrote no qualification. Run-v3 added explicit child-failure propagation and corrected the disposable-schema omissions; its saved log shows all eight children and parent passing. These retained failures are not relabelled as passes, and prior source reviews or an older 510 setup do not substitute for this final compiled composition evidence.

## Limitations — do not promote this result

- Data is the preserved completed local510 snapshot copied into a new disposable database/schema. Historical claim/ledger JSON was preserved, but PostgreSQL xmin values were newly observed. The original native authority and original setup execution identity were not restored; no fresh canonical 510 creation was demonstrated here.
- Transcript message, prompt, tool events/HTTP status/response, usage, model, provider price/rates and completion content are synthetic fixtures. The local test signing key is not production authority. The complete synthetic transcript’s `QUALIFIED` status and the signed-partial `BLOCKED` result establish the readback behavior only. They do not establish actual Case12 acceptance, capture authority, a real prompt, real tool execution, provider completion, human acceptance, or live acceptance.
- Rollback-suite ECS metadata and API responses are controlled doubles. It does not prove AWS IAM/task behavior, authenticate a real native helper, qualify an aggregate hold, dispatch or run native setup, or establish the positive full-CLI execution path. Prior source/helper reviews remain source-level or negative-ingress evidence only and do not fill those runtime gaps.
- The reduced schema/search-path shim and restored rows are not production schema, migration, RLS, concurrency-wide, or production-load qualification. The documented 240-second limit applies to test-data construction, not the measured application transactions.
- No AWS/IAM/task, operator native hold, provider, journal, original-prompt, human-acceptance or live-acceptance action was performed or authorized by this review. Do not infer any of them from this PASS.

Conclusion: the frozen packet supports a positive, narrowly scoped finding for the final compiled readers/hydration and native local transaction composition on restored data, plus the separately saved local DB rollback/admission behavior with ECS transport doubles. It does not support full Case12 completion/acceptance or native cloud execution qualification.

Key saved artifacts: `evidence/independent-pin-summary.json`; `evidence/qualification/runs/run-v3/qualification.json`; `evidence/qualification/native-composition-v3.log`; `evidence/qualification/native-admission-rollback.test.mjs`; `evidence/qualification/runs/run-v1/native-admission-rollback-qualification.json`; `evidence/qualification/run-v1-disposition.json`; `evidence/qualification/retained-attempts.json`; `evidence/qualification/cleanup-readback.json`.
