# Meri C2 postapproval adapter — independent local draft review

Status: BLOCKER for use; this is a source review only, not execution authorization. No native CLI, cloud, database, or provider was called, and tests were not run. Implementation files were not modified.

## BLOCKER — native adapter input does not enforce same-process approval ownership

`evidence/build-case14-postapproval-input-v1.mjs:10-24` obtains actual approval authority via `currentCase14ApprovalAuthority(approvalOutcome)` and derives the capture run and approved owner from it. But the executable adapter in `evidence/case14-postapproval-inner-v1.mjs:209-213` accepts arbitrary JSON from `C2_CASE14_POSTAPPROVAL_INPUT_B64` after only checking a caller-provided byte hash and calling `validateInput`. `validateInput` at lines 40-47 validates the approval-evidence digest only as a 64-character hash; it does not authenticate it or bind it to an in-process `approvalOutcome`. The `inputByteSha256` is likewise supplied by the caller at lines 209-212, so it proves byte consistency, not builder provenance.

This is not merely an evidence-label issue: the admitted fields drive `recall-bind` at lines 114-115 and the budget operations at lines 116-124. The native recall implementation then replaces the owned capture binding and clears `captureEvidence` and `captureProviderBudget` (`evidence/apps/api/scripts/meri-case14-recall-setup.mjs` is only the CLI wrapper; its invoked source is not included here). Thus the native current-owner check limits which memory is mapped, but does not establish that this run's setup was authorized by the exact same-process captured approval. A copied/constructed input can assert an arbitrary UUID and syntactically valid `approvalEvidenceSha256` and reach native planning/binding if the pinned owner is currently approved. The builder's WeakMap authority does not cross into, or get verified by, the adapter process.

Required before use: establish an unforgeable/one-use provenance handoff from the builder to the adapter (or otherwise keep the authority gate in the same process that dispatches the native phases), and test that copied or caller-constructed JSON cannot dispatch even the first native phase. Merely checking a caller-supplied file digest is insufficient.

## PASS — scope mapping and sequencing, with the provenance blocker above

- `evidence/build-case14-postapproval-input-v1.mjs:10-24` maps the captured run, fixed reviewer/tenant/client scope, and `evidence.after.fixtureEvidence`; its authority lookup is the intended same-process gate, but it is not enforced downstream as noted above.
- `evidence/case14-postapproval-inner-v1.mjs:40-77` fixes identity/role, candidate/owner shape and hash, exact cost/token/attempt limits, retained rate-evidence hash, and rejects an expired/insufficient-validity rate record. Lines 92-94 map only `MEM-PROPOSAL-14` to the approved physical item.
- Lines 86-90 and 101-124 sequence recall plan → recall bind → budget plan → budget install. Recall bind carries the exact plan digest and fixed confirmation. Budget install maps plan-produced current-owner, capture-binding, prior-qualification, and tenant-row-version values into the four expected fences (lines 117-124); receipt checks are at lines 142-184.
- Canonical CLI argument contracts agree with the adapter's invocation: `evidence/apps/api/scripts/meri-case14-recall-setup.mjs:7-18` expects mode, input flag/path, and `--out` with an absolute path; `evidence/apps/api/scripts/meri-capture-provider-budget.mjs:8-42` expects the corresponding five arguments and `--input-env` is supported. Adapter dispatch at `evidence/case14-postapproval-inner-v1.mjs:233-235` supplies these forms. The budget CLI additionally enforces target, namespace, DB URL, and allowed role/case scope (`meri-capture-provider-budget.mjs:43-50`).
- The recall CLI passes only the input context and operation fields into the canonical transaction functions (`meri-case14-recall-setup.mjs:48-56`). The budget CLI constructs restricted dependencies with a forbidden provider proxy and invokes only plan/install (`meri-capture-provider-budget.mjs:55-78,84-120`). This wrapper-level evidence is not a review of the underlying budget implementation, which is outside the supplied evidence and is being reviewed in its separate lane.

## PASS — bounded receipt transport and fail-closed handling; reconciliation remains necessary

`evidence/case14-postapproval-inner-v1.mjs:126-140` accepts only bounded (≤32 KiB) JSON receipt files, validates a known shape, emits the exact child bytes with byte digest/base64 before proceeding, does not print child stdout/stderr, and requires child exit 0. The outer child invocation suppresses stdout/stderr and reads only the `--out` path (`233-238`). Lines 194-200 stop on error, disable automatic retry, and label ambiguous partial native setup for reconciliation. The direct-main path also checks per-process stage-marker nonexistence and creates an exclusive intent marker (`214-217`).

There is a real lost-receipt window to account for: both native CLIs perform the native operation before writing the receipt file (`meri-case14-recall-setup.mjs:48-61`; `meri-capture-provider-budget.mjs:117-124`). A commit followed by receipt-file write/sync failure can therefore leave a native mutation without a valid receipt for the outer adapter to transport. The adapter fails closed and requests reconciliation; it does not retry or roll back. For budget install, the CLI's catch path may attempt to append a `FAILED` JSON record after a write error (`meri-capture-provider-budget.mjs:128-140`), which can leave a non-single-JSON file rather than recover the committed receipt. Treat the explicit reconcile state as mandatory in this case; never infer that a missing receipt means no mutation.

The no-retry guarantee is strong within one running `sequence` (lines 108-140, 194-199), and the native recall CLI's exclusive receipt path plus owned run mapping help prevent a second bind. The `/dev/shm` marker at lines 214-217 is process/container-local, however, not a durable cross-task replay lock. The caller/orchestrator must preserve the no-retry rule and perform read-only reconciliation after an ambiguous result; do not rely on that marker to prevent a restarted task from replaying input.

## PASS — tests reflect adapter contracts, but are synthetic coverage only

`evidence/test-case14-postapproval-inner-v1.mjs:44-63` models the four ordered receipts and the binding/fence values; lines 64-81 cover tampering, insufficient rate validity, stop-on-unknown-failure for each stage, and wrong-owner rejection before bind. Those checks correspond to the assertions and sequence in the inner adapter, not to live native CLI behavior. The test's `nativeMock` manufactures receipts (`30-58`) and does not launch either CLI, inspect real database transactions, test CLI argument parsing, exercise receipt-file failures, or test the missing provenance boundary. The retained `evidence/local-synthetic-qualification-v2.json:2-24` correctly labels execution `LOCAL_SYNTHETIC_ONLY`; it is not independent proof of running tests. I did not run the tests.

## Live prerequisites — known external gaps, not novel code findings

- Retained rate evidence expires at `2026-10-04T05:29:01.587Z` (`evidence/reviewed-rates-retained.json:6-7`); the checkpoint says it is not usable for the required 45-minute validity (`evidence/checkpoint-v2.json:58-69`). The validator fails closed at `case14-postapproval-inner-v1.mjs:75-76`; do not extend or reuse stale evidence.
- Approval itself can incur unaccounted embedding costs; this adapter explicitly excludes those effects (`case14-postapproval-inner-v1.mjs:1-2,191-192`; `checkpoint-v2.json:81-86`).
- The parent is separately building the preapproval combined USD 15 hold (USD 1 approval + USD 14 recall) and terminal projection evidence. Those remain live prerequisites, not findings against this postapproval adapter.
- Evidence marks native execution and live acceptance NOT RUN (`checkpoint-v2.json:71-89`). This review grants no authority to execute.

## Review disposition

BLOCKER: the executable adapter does not authenticate the same-process owned-approval handoff. Apart from that finding, no further source defect was established in the reviewed wrapper/sequence and CLI argument mapping. Resolve the blocker, complete the separate native budget review, satisfy the external prerequisites above, and obtain explicit execution authorization before any live use.

Evidence index: `evidence/input-manifest.json` lists the reviewed builder, inner adapter, tests, retained rates, checkpoint, and CLI wrappers. The underlying invoked native transaction implementation is not present in the supplied evidence; assertions about its behavior above are limited to what these wrappers invoke and what their receipts/contracts express.

## Correction: canonical-source cross-reference

The builder imports `currentCase14ApprovalAuthority` from `../../../meri-c1-20261002/evals/meri/live-v1/case14-approval-capture.mjs` (`evidence/build-case14-postapproval-input-v1.mjs:7`), while the supplied review copy is `evidence/evals/meri/live-v1/case14-approval-capture.mjs`. The referenced sibling source was not included in the manifest, so this review cannot establish byte/source equivalence between the imported authority implementation and the included copy. Before use, pin and review the exact imported file/version as part of the source set; the builder's API/web SHA equality check does not itself prove that the imported authority code is the reviewed implementation.

This missing-source verification is an additional BLOCKER for source-complete approval: the authority handoff and reviewed source identity must both be established.

Correction: the preceding disposition's phrase “Apart from that finding” is limited to reviewed files; it does not waive the separately stated missing imported-source blocker or the separate native implementation review.

Review result: BLOCKER / local draft only.
