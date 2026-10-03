# Case01 continuation — one submitted stream, receipt persistence failure

The reviewed continuation ran once on operator `f9d1939782dc95d648e2e1b4528752e0f716db64`,
using the original run `bd35c0f4-1604-4371-b7e9-a1338369e53f`, conversation and
reservation. It passed current actor/build/fixture/qualification checks, native
preparation and the extra no-admission recheck. It sent exactly one native stream.
No conversation creation, new reservation, fixture setup or application browser
write occurred. Its session was revoked and the original failed evidence remains.

The API returned HTTP201 with a stream ending in `MERI_STREAM_SETUP_ERROR` /
`meri_capture_receipt_readback_mismatch`, followed by `done`. There was no
`turn_accepted`, so native completion checks correctly returned CAPTURE_UNCERTAIN.
The stream's `accepted:false` does not mean no provider work happened. The
separate owned conversation GET recorded five settled provider attempts: two
Titan retrieval embeddings and three OpenAI calls, 90,733 accounted tokens and
$2.292602 under qualified upper-bound pricing. This is server accounting, not
a claim about invoiced cost or aggregate settlement.

The subsequent owned transcript GET returned403 `meri_capture_policy_readback_denied`.
The API persistence function commits the assistant before independently saving
the final signed receipt/policy pair; failure of that latter transaction can
leave a real provider-completed reply inaccessible through the guarded GET.
No transcript/body or accepted answer is inferred from the failed GET.

The terminal readback's original sessionRevoked:false field was only assigned
true after whole-operation success. The retained AssertionError for403 survived
the helper's finally, which awaited revocation and required a revoked response;
a cleanup failure would have replaced the error. The separate cleanup
reconciliation records this limitation and confirms that executed control flow
without changing the original file or creating another session.

The original21-event journal is unchanged and the full$15 reservation remains
active. Neither claim may be reused. The saved recoveryProof is a pre-execute
snapshot; its submissionFenceConsumed:false is not a post-execution observation.
The native result proves the one observed stream submission. No retry, refund,
second reserve, forced settlement or human grading has occurred.

This is a product receipt-persistence defect after the browser-runner repair.
Fix and reproduce it through actual Prisma/PostgreSQL, then reconcile this run
and its budget before any subsequent capture. Full original acceptance remains
0/75, CD0/7, CW0/8. Earlier failures and setup success remain separate evidence.
