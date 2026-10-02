# Original01 retest: runtime failure

The repaired planner passed live setup and reached the governed runtime on
API509/source324195 and orchestrator99/sourceddb55. One exact original prompt
was submitted in a fresh synthetic conversation. It did not produce the expected
answer. The saved response was:

> I could not complete this turn because the MeriV3 reasoning runtime was unavailable. No unapproved action was executed.

The legacy collector stopped at `CASE01_CITATION_MISSING` before saving its
stream. A separate ordinary authenticated read recovered the same persisted
conversation: two messages, a runtime-error finish, no citations, no observed
answer-model call, and one settled embedding request with11 input tokens and
one micro-dollar of accounted usage. Both temporary sessions were revoked.
See [the bounded result and source hashes](runtime-failure.json).

The retest is **FAIL**. It does not erase the first planner-guard failure. Its
native aggregate reservation remains active pending terminal accounting at this
checkpoint. No second turn, refund, journal replacement or human grade was made.
The original75 suite remains incomplete.

Setup used the existing five-source corpus, preserved all historical claims
and the original conversation, and created one new ordinary owned conversation.
Fresh budget plan/install receipts verified the current binding and retained
the prior qualification CAS. Local collector checks passed14/14. The independent
Hermes/Kimi review returned BLOCK; its claims and root's source adjudication are
recorded separately in the qualification, not relabeled as a model PASS.

The indexed files retain their original bytes. The readable failure summary
omits credentials and signed transport material; its hash points to the actual
local authenticated readback. Source policy:743fd708c3484604e8a35ea1039adeca3b1e331f,
machine map dated2026-09-30.
