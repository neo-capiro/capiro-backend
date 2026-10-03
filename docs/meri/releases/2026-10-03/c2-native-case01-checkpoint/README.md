# C2 native Case01 — original setup and stopped bootstrap

Run `bd35c0f4-1604-4371-b7e9-a1338369e53f` completed its bounded fixture binding
and provider-budget qualification at 2026-10-03T21:44:39Z. Execute-v3 has six
ordered events, exit zero, exact receipt readback and a stopped utility task with
an inactive definition. It did not seed, reset or reapprove the fixture.

The original native bootstrap then stopped at 21:49:16.280Z before entering
native execute. Its 13 fsynced events contain no capturePrepared or execution
intent, and its final summary reports executionAttempted false. It created one
owned empty conversation, `f493355c-ee97-44a1-a0b0-e05e7b104b59`, and revoked its
temporary session. The exact failed process is retained and must not be rerun.
Missing artifacts alone would not establish the point of failure: native prepare
can claim a reservation before initializing artifact storage.

The shared journal contains the unchanged original 20 events plus reservation
`cf7ea1df-6996-4d29-a5d5-b98db9c85c61` for this run. Its $15 ceiling remains held;
no refund, reset, settlement or second reserve has occurred. This archive records
that original stopped checkpoint. A separately qualified continuation, if any,
must preserve the same conversation, reservation, claim and original evidence.

Earlier setup attempts remain visible: task-definition comparison rejected only
ECS normalization before any first RunTask; the second plan failed with a masked
error. A separate read-only diagnostic observed P2028 at HYDRATE_PREVIOUS, and
the final setup forwarder gave the existing transaction 30 seconds. This proves
the diagnostic's cause, not the exact masked exception of the earlier plan.
All utility tasks stopped and their definitions became inactive.

The actual deployed pair is API519 source5b086a6b and orchestrator115 sourcefb17c7eb;
Web388 and nightly136 remain unchanged. Setup, build and browser evidence do not
establish benchmark acceptance. Full acceptance remains 0/75, CD0/7, CW0/8, and
human grading is outstanding. Local Case20 files are preparation only.

Private auth inputs, task definitions and the original claim are excluded from
Git; the selection retains their hashes. Exact public receipt bytes, tests,
failures, reviews, transport joins and native checkpoints are in artifacts.json.
The separate read-only browser diagnostic reproduced missing Clerk readiness
after navigation; it does not prove the original generic exception's identity.
