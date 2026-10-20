# Membership cancellation delta review

No unresolved finding in the final reviewed delta. The three post-snapshot checkpoints close the observed transaction-settlement gap. A fourth checkpoint at transaction-callback entry closes the additional acquisition gap found during this review. Fresh qualification of the changed production source is still required.

Reviewed checkout: `../backend-current-authority`, working-tree delta on local candidate `567a95db943bafc2c7aeba2646518534a6ebfd0e`. No Jest, compiler, copied-source run, database or provider action was performed by this reviewer, and no source was edited. Prior reports and failed-run evidence are retained unchanged.

## Failure and correction

The saved stage-3 membership-only run is **27 passed / 1 failed**, not a green qualification. Its remaining cancellation case received `onlineReads = 2` instead of `1`: cancellation injected after the first transaction callback settled was recognized only after the next online identity call had already started. The Date fixture correction allowed the other 27 cases to reach their intended behavior; it did not resolve this production gap.

The current [service](../backend-current-authority/apps/api/src/auth/application-membership.service.ts) adds `control.assertActive()` immediately after each awaited first, second and latest snapshot (lines 31, 37 and 44). A successful callback's last internal check cannot cover the later await of transaction completion. These new checks stop the next identity/recheck operation and reject a cancelled final result before comparing revisions or constructing a receipt.

The independent review also found that the first transaction callback statement needed a check. Existing `PrismaService.withTenant` lines 150-158 await transaction acquisition and `set_config` before invoking the service callback. Cancellation during that await could otherwise start a membership query before the first internal checkpoint. The final service now checks at callback entry (line 72), before `member()` I/O. The new specification case cancels through the synthetic pre-callback hook and asserts no `snapshot-member` event, no roster query and only one online read. Existing assertions were not weakened; one focused negative case was added.

## Await-boundary trace

| New service boundary | Check before subsequent service I/O or receipt work |
| --- | --- |
| Initial online/current identity await, line 27 | Line 28, before first snapshot |
| First outer snapshot await, line 30 | New line 31, before second online identity call |
| Second online/current identity await, line 32 | Line 33, before second snapshot |
| Second outer snapshot await, line 36 | New line 37, before local identity recheck |
| Local identity recheck await, line 39 | Line 40, before latest snapshot |
| Latest outer snapshot await, line 43 | New line 44, before comparison; line 46 remains before receipt construction |
| `withTenant` acquisition/setup before service callback | New line 72, before first membership query |
| First member query, canonical roster query, final member query in callback | Lines 74, 78 and 86 respectively, before subsequent service work |
| Snapshot rejection/transaction failure | Line 91 checks cancellation before error mapping; no new I/O |

`member()` awaits one query and then performs synchronous validation; its caller immediately checks activity after it returns. No other uncovered new-service await-to-next-I/O transition was found. The existing identity owner's internal session/system-transaction operations remain already-started owner calls and are not redesigned or made cancellable by these checks. This is refusal at service boundaries, not proof that abort cancels underlying I/O or makes membership/session/wall observations atomic.

## Current production seal

The exact production delta is four added `control.assertActive()` statements in the service. All other reviewed production hashes remain unchanged from [SOURCE-REVIEW.md](SOURCE-REVIEW.md).

| File relative to `backend-current-authority` | Current SHA-256 |
| --- | --- |
| `apps/api/src/auth/application-membership.ts` | `c40054c008e5d710be904cbd285e39aad3d5bc7623bb3c05cf08690e6857f0c6` |
| `apps/api/src/auth/application-membership-request.ts` | `f1ff3779a9817dc0fee330f1a8eb67faeea971f8e4e1a18109936377324ff340` |
| `apps/api/src/auth/application-membership.controller.ts` | `81b4e23fe2a5596cf4daaacf0fcc08af747ca58aa17e8853500c25e3a4553386` |
| `apps/api/src/auth/application-membership.service.ts` | `874d53647757576239b2d71d63a6ddebcd6eddcf24ce6458bf1893ef4922faef` |
| `apps/api/src/auth/application-authority.module.ts` | `a9a450297f1c37b5f6c3164e3fa370542172470f843c43017457ce9f8f51b1f3` |
| `apps/api/src/memory/memory-wall.helpers.ts` | `c94ceeb0687fa09c3673aa1a97022439d15d4686e4e7b80f580231092350b294` |
| `apps/api/src/tenant/tenant-context.middleware.ts` | `80511693576467e56004fd7147f3c79c23f9ad79f9cc543c88a381489b40c907` |

Current membership specification SHA-256: `bec1df467a89583de93a5907350ddb6dd7a0b31dea4f65c982614291aaac4593`. Module specification remains `aff3e70651d6177e18c9664a66b41fc34d22432933b58a01ec26ee784e4dca0f`.

Saved stage-3 evidence SHA-256: `focused-attempt3.receipt.json` = `5002b1d8bbec5db2bf269a4445eedbbb7c8113b4667c0c7c5dad2266437f3574`; `focused-attempt3.result.json` = `56a9170c30b4842f9c74bc32460183eec1b0e2318bcf34576ec1e02adf73d518`. The prior three-check intermediate service hash `9d771282318932e71b034c126d3c2324bca2bec9be1cff9f4d8ed1c3b104f43d` is superseded by the four-check hash above.

The earlier 42 passing module tests apply to their recorded source and cannot be carried forward as a pass for the changed service. The planned fresh stage must qualify both affected specifications against the new hashes; semantic typing/build/native HTTP/SQL and startup binding remain separately unqualified. No review action was denied, pending or uncertain.
