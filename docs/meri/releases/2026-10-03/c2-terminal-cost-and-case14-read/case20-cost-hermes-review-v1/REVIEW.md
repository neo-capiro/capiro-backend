# Case20 terminal provider-cost source review

Status: PASS — bounded source review of the requested Case20 cost-only change. No source finding requiring a change was identified in the fixed review scope.

## Scope and method

Reviewed the current repository files requested by the user:

- `evals/meri/live-v1/case20-terminal-cost-authority.mjs`
- `evals/meri/live-v1/case20-terminal-cost-pins.mjs`
- `evals/meri/live-v1/capture-spend-aggregate.mjs`
- `evals/meri/live-v1/lib/windows-capture-spend.py`
- `evals/meri/live-v1/tests/case20-terminal-cost.test.mjs`
- `evals/meri/live-v1/tests/case20-terminal-cost.unit.py`
- named Case20 cost fixtures, including the 23-event journal fixture and fixed proof fixture
- `lib/windows-artifact-protocol.py` and `lib/windows-owned-artifacts.py` only to follow the native file/handle behavior used by the reviewed reducer.

This was read-only source inspection. I did not execute tests or product code, read secrets, contact cloud/auth/DB services, mutate the repository or journal, append an event, launch a product model call, change configuration, or review `continuation-hermes-v1`.

## Findings

None within the source-review scope.

The fixed pins bind the requested run/reservation and exact retained evidence. The terminal-cost authority checks the retained failed execution, blocked receipt, actor/client/tenant and source joins, claims, checkpoint and authorization, raw provider ledger/readback, captured message identities, and deadline ordering before it produces a one-use in-process capability (`case20-terminal-cost-authority.mjs:10-22, 25-50, 52-105, 106-140, 150-169`; fixed evidence paths and byte/hash/semantic pins in `case20-terminal-cost-pins.mjs:2-146`). The computed disposition is explicitly cost-only: `CAPTURE_UNCERTAIN`, `NOT_EVALUATED`, and no capture authority (`authority.mjs:141-147`). The failed receipt remains `BLOCKED`; provider accounting is independently recomputed from exactly two settled attempts and pinned rates rather than trusting redacted token fields (`authority.mjs:101-140`).

Capability use is identity-backed by a private `WeakMap`, deleted on consumption, and the pinned evidence and checkpoint are reloaded and compared at consume time (`authority.mjs:7, 160-169`). The aggregate entry point accepts only the exact invocation string and sends only a `fresh_reconcile_terminal` request with this proof (`capture-spend-aggregate.mjs:82-91`). The reducer permits this fixed Case20 event only at sequence 24 with the exact Case20 run/reservation, exact 23-event prefix digest, exact proof digest, active matching reservation, fixed 15,000,000-micro ceiling, and no capture/grade upgrade (`windows-capture-spend.py:233-256`). The event-22 Case01 branch retains its separate prior-prefix/proof pins (`:236-240`).

Native journal handling re-reads and validates the fixed root, authorization bytes, identities, entry set, and reducer state before appending; it uses the journal handle as an exclusive writer lock, appends rather than replacing the prefix, flushes, and verifies the resulting bytes (`windows-capture-spend.py:275-346`; supporting native handle and write/flush/readback behavior in `windows-artifact-protocol.py:282-345` and `windows-owned-artifacts.py:105-165`). The reducer checks the exact 20-event legacy prefix and explicitly retains the event-22 regression guard (`windows-capture-spend.py:196-218, 233-246`).

The 30,000,000-micro aggregate limit and 15,000,000-micro Case20 ceiling are not widened by this closure; earlier prefix accounting remains unchanged (`windows-capture-spend.py:16, 196-218, 228-256, 268-272`). The ordinary reducer path accepts a subsequent unique reserve and settlement after event 24, while preserving the event-24 proof and prefix (reserve/reconcile/settle handling at `:219-267`). The tests include a post-event-24 reserve check (`tests/case20-terminal-cost.unit.py:30-45`); they do not assert a subsequent settlement.

Tests are substantive on inspection: the JS unit tests perturb scope, source, status, receipt, raw cost, attempts, rates, clocks, checkpoint, claim and cap; test pin completeness, forged authority, single use and consume-time revalidation (`tests/case20-terminal-cost.test.mjs:13-57`). Its integration test writes evidence copies into a disposable temp directory (`:58-78`). The Python suite sets up disposable NTFS copies and includes exact append/replay/tamper/prefix-drift/identity-drift/authorization-drift, interrupted-write and competing-writer cases (`tests/case20-terminal-cost.unit.py:11-24, 30-108`). These are test-code observations, not test results produced by this review.

## Exact limits / non-claims

- I did not run tests. I cannot independently attest the reported JS28 or NTFS8 results. The referenced `C:/dev/main/outputs/meri-c2-20261003/cost-supervised-v1` directory was not present when checked, so no supervisor final logs were available to inspect in this review. The source tests describe eight Python test methods, but that is not evidence of a successful run.
- This is not the human rubric, product acceptance, or an authorization to append event 24, make another capture, retry, grade the answer, or promote Case20/row20.
- No live append was performed. The actual failed capture remains `CAPTURE_UNCERTAIN` / `NOT_EVALUATED` as represented by the reviewed proof.
- The finding status is limited to the specified source, fixtures, and reducer/file-protocol paths; it makes no claim about runtime behavior beyond code inspection or about evidence not read here.
