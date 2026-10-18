# Membership Date fixture review

No finding in the fixture-only correction. It is appropriate for a fresh focused qualification run; it does not convert the preserved failed run into a passing result.

Reviewed `backend-current-authority/apps/api/src/auth/application-membership.spec.ts` lines 91-101 and the saved stage-2 result, source receipt and Date realm proof. Stage 2 actually ran 70 cases: 59 passed and 11 failed. The real Nest module suite passed all 42 cases; the service VM suite passed 17 of 28. Its 11 failures are consistent with rejection in `ApplicationMembershipService.member` before the intended client/change/cancellation behavior: valid-path cases received 503, conflict cases received 503 instead of 409, and the cancellation case received the member-unavailable error.

The VM loader explicitly supplies the test realm's `Date` to actual owner sources. The saved 64 MiB reproduction reports that Node `structuredClone` retains timestamp/getTime but creates a Date failing that realm's `instanceof Date`. The correction keeps `structuredClone` for the synthetic DB row and reboxes only an original top-level `updatedAt` already recognized as a Date, using `new Date(value.updatedAt.getTime())`. This supplies the same constructor as the loaded source while retaining the original timestamp, including NaN. It does not turn a non-Date into a Date, fabricate a version, alter production validation, or weaken the invalid-version assertion.

An exact byte comparison was possible without an old source copy: replacing only the new helper block with its prior one-line `structuredClone` definition reconstructs SHA-256 `7fd36c83e66019d516294f250e2595fbc69dc4b858a0dfb11a3a6fb40a4c2905`, exactly the stage-2 source receipt. Therefore assertions and all other specification bytes are unchanged. The corrected specification SHA-256 is `05086eb8dd6b2a3c9a6fc8b2dbe0712e945b90d81a48e40ddd24811688a657b6`.

All seven production files listed in [SOURCE-REVIEW.md](SOURCE-REVIEW.md) were rehashed and still match both that review and the stage-2 receipt. No production source change is needed for this fixture defect. A new qualification run remains necessary to establish all intended branches, including prior 503 negatives that may previously have passed before reaching their intended malformed-roster or overflow check. No Jest or reproduction was rerun by this reviewer; no source was edited. Only this review Markdown was written.

Evidence SHA-256:

| Saved file in this directory | SHA-256 |
| --- | --- |
| `focused-attempt2.receipt.json` | `b7660bd6ed60a8aafa3aa2074bc2047bcdd34058c8ad03f007614f716485e636` |
| `focused-attempt2.result.json` | `18ad64fcc7174cf904c6eb55586833c332bd59ad883c003c0cc45428c414ace9` |
| `fixture-date-realm-proof.json` | `8fa26342471256af5331a21f7978881557504e74951cd29300238fec8604fe93` |

No review action is denied, pending or uncertain. New test qualification is outside this review and has not been claimed.
