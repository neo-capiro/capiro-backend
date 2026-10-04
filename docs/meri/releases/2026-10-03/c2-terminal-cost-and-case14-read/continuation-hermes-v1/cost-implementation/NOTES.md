# Case20 cost-only reconciliation draft

Scope: this output directory only. No repository, journal, fixture, service, release, or runtime files were changed. No tests were executed.

## Included

- `evals/meri/live-v1/case20-terminal-cost-pins.mjs`: new fixed Case20 scope and evidence-path draft. Exact byte counts and SHA-256 pins are explicitly placeholders; `PINS_READY` is false, so the module cannot issue authority.
- `evals/meri/live-v1/case20-terminal-cost-authority.mjs`: bounded proof/authority draft modeled on existing Case01 code. The validator binds the case/run/reservation/conversation, BLOCKED/CAPTURE_UNCERTAIN outcome, 23-event checkpoint and prefix digest, exact readback, full provider-state hash, rates-derived amount/token totals, and deadline ordering. Its private one-shot WeakMap capability is not a ledger-adoption API. It does not grade or confer capture authority.
- `evals/meri/live-v1/case20-cost-owner.patch`: proposed minimal integration patch for the existing `capture-spend-aggregate.mjs` and `lib/windows-capture-spend.py`, plus a draft test. It adds an operation distinct from normal settle and the existing Case01 terminal event; it requires event 24, the exact Case20 reservation and unchanged prefix, and retains the current append-under-lock/flush/readback implementation. The Python proof digest is deliberately a fail-closed supervisor placeholder.

## Grounded source observations

The Case20 execution JSON says `verdict: BLOCKED`, one synthesis submission, `CAPTURE_UNCERTAIN`, `acceptanceStatus: NOT_RUN`, and preserves the exact active reservation. The fresh checkpoint is event 23 with journal SHA-256 `d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b`, known settled amount 12,133,883 micros, and active `20:f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b` reservation `7ea73cdc-526e-4b31-8c28-b0636ea8d2ae` at 15,000,000 micros. The post-deadline readback is `READBACK_CAPTURED`, session revoked, journal unchanged, no app writes/submissions, provider ledger matches receipt, and after deadline. It records exactly two settled attempts, 1,497,175 micros, and 59,737 tokens. The requested whole provider-state hash is pinned as `3d665a2323c36e38733b7c1576af13976c0c4a573fa1a2ccc91f668a630ca5f5`.

The source execution is BLOCKED, not acceptance; `CAPTURE_UNCERTAIN` and `NOT_EVALUATED` remain. Numeric Token values redacted in receipt evidence must never be treated as equal to raw receipt fields. No reservation/case cap or aggregate limit is raised; the draft only permits admission cases 01/20 per existing fresh logic.

## Explicit blockers / not acceptance

- The referenced handover section 6 and Case01 cost-test filenames could not be read: the file tools returned not found / root unavailable for those exact paths. Existing authority, pins, aggregate owner and Python reducer contents were readable and informed the draft.
- The supplied Case20 readback result, response-0, response-1, execution, and aggregate checkpoint were readable. The requested `captured-inputs` file was not present at the assumed path; only execution and checkpoint were available from the original run directory.
- With no terminal/hash capability allowed, exact byte counts, input hashes, canonical stable proof digest, or append-event digest could not be independently generated. Placeholders are intentional and make the proposed path reject rather than act. Supervisor must generate pins from exact retained bytes and independently review the resulting patch before enabling authority.
- The patch has not been applied to source, linted, executed, or tested. Source review is not acceptance. No journal append was performed. Case20 remains `CAPTURE_UNCERTAIN / NOT_EVALUATED` until lead-owned integration, verification and journal action.