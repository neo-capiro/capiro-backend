# Case01 failed receipt: diagnosis and cost-only terminal reconciliation

The exact original Case01 continuation submitted one stream, performed five
provider calls and then failed `meri_capture_receipt_readback_mismatch`.
[The unchanged failed attempt](../c2-case01-recovery-attempt/README.md) remains
CAPTURE_UNCERTAIN with no full-case acceptance or human grade.

A bounded read-only database task on API519/image d20110a1 confirmed exactly one
owned synthetic user message and one assistant, two scoped context packets,
and the existing provider ledger. The task had no workload IAM role or provider
secrets, used SET TRANSACTION READ ONLY, and was stopped; its task definition is
inactive. Raw JSON text and generated Prisma metadata agree. The assistant found
the approved Aster briefing preference but its pending-proposal tool returned500.
These diagnostic bytes are not a signed accepted capture or a user-level readback.

Actual Prisma/PostgreSQL reproduction established that missing clock API proof
was assigned `undefined` before signing, then omitted by JSON storage. A small
qualified finalizer repair preserves a signed BLOCKED receipt by omitting that
absent field before signing. It is not yet deployed. Source investigation also
found original01/14 proposal-read rejection at the capture budget boundary,
clock validation that rejects that tool, and a final receipt ceiling of3M micros
despite the existing admitted15M qualification. Those bounded repairs are active;
no model, provider configuration, approval, fixture or budget increase is implied.

The ordinary owned conversation GET at23:01:25.773Z, after the original provider
deadline22:57:18.896Z, retained the exact full budget-state SHA134637a3196af3b91c53ced6af4b6103e8c6b9d962254ba46c5858c376c5d011.
All five attempts were settled; their pinned qualified rates recompute to
2,292,602micros and90,733tokens. The owned session was revoked. This is recorded
provider accounting under conservative qualified rates, not an invoice claim.

The independently reviewed fixed-run terminal-cost extension passed26 authority,
5 actual NTFS,5 existing JavaScript and12 existing NTFS tests. Its event is
distinct from accepted-capture settlement, requires the exact original21-event
journal and proof, and retains captureAuthority:false, answerGrade:NOT_EVALUATED,
and CAPTURE_UNCERTAIN. Permanent tests use disposable fixtures; operational
authority separately rereads17 exact pinned observations. No replacement journal
or restored provider submission capability is created.

The root executed the append exactly once at23:09:37.405Z. The22-event journal
SHA is a8c8101a4d806ef8080e1648c9e46568a55b7b5f93cb0f053a3d601404bfe3b5;
its original21-event prefix is intact. Fresh recorded cost is$12.133883, remaining
budget$17.866117, and no run is active. Older unresolved billing stays separate.
No new provider request, fixture write, refund, replay, or benchmark PASS occurred.
Use the saved aggregate checkpoint for the next qualified case; never re-adopt
the original20 prefix or rerun either Case01 claim.

Hermes supplied a separate read-only remaining-C2 checklist audit using the
configured coding-agent model. Its audit is advice, not product acceptance;
its coding-agent usage is not charged to this product-benchmark journal.

Original acceptance remains0/75, CD0/7 and CW0/8. Next: finish and release the
bounded capture-contract repair, then use the existing Case20 preparation for
the next independently qualified capture before returning to the remaining C2
memory, approval, artifact and fullCD cases.
