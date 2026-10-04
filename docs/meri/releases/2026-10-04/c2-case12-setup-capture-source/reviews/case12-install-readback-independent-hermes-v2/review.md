# Frozen Case12 install/readback/native-corpus refactor review

Verdict: PASS_SOURCE_ONLY_WITH_RUNTIME_BLOCKER

No concrete source defect was established in the frozen installation, provider-rate, refactored native authority, or readback paths reviewed here. This is source-only qualification—not a native install/readback PASS, readiness decision, live authority, or permission to capture.

## Scope and evidence

File-only review of the supplied frozen source, dependencies, patch, excerpts, prior review, and test log. No database, cloud, provider, or implementation calls were made; no evidence files were changed. This review was written to `review.md` only.

The manifest pins the principal changed source files:

- `meri-case12-capture-authority.ts`: `3d2dc0b7be36facb0673b98d5b6bd3e25cea3cd1a5f6423a896a5a470fcc7b5a`
- `meri-case12-capture-install.ts`: `dd4283ce9748190b545a76f941c53082c6c7e4927ab6468aae35a9aeb5a6ed51`
- `meri-capture-provider-budget-install.ts`: `830987f41650571817c23d52c7de06818993365af2516a3d704bc9158b33e289`
- `meri-case12-capture-readback.ts`: `496fb5390774ce93843eab647d05260d04fcec8989df980ddbd4444164e8de56`
- `meri-case12-capture-readback.spec.ts`: `cf6728ae9fb2d6faadf7619de4c73528a0decac7d15bd084992916d8f8b5e4db`

The old authority source is included for comparison. Review does not infer missing installation-CAS tests as passing: those tests are independently being added output-only, and no testPASS is claimed.

## Findings by requested gate

### Case12 binding install and CAS

The plan records the tenant `xmin` row version plus hashes of the exact prior capture binding and provider qualification, and binds the proposed capture identity, actor, tenant, client, run, current verification hash, and completed-setup tuple into the plan hash. Installation requires the explicit one-time confirmation and expected plan hash, re-runs the plan/current native proof under the tenant-row lock, then updates only the capture binding while removing `captureProviderBudget`. The `WHERE xmin` fence and returned binding/removed-budget readback are checked; stale plan, CAS conflict, and readback mismatch fail rather than returning an installed result.

A pre-existing Case12 binding is rejected before native inspection/update, so this path does not expose an overwrite or replay/recovery route for an already-installed Case12. The provider qualification is not silently carried forward: it is removed and must be installed separately. Failure after the update relies on the caller propagating the thrown error so the enclosing transaction rolls back; the function is explicitly `InTx`, and the supplied evidence contains no caller/test proving rollback behavior for a caller that catches that error. This is a transaction-use contract to preserve, not an observed exploit in the supplied call graph.

### Native owner and refactor

The new `readMeriCase12CompletedCorpusInTx` seam obtains the native current-corpus proof and setup-completion binding before installation constructs or writes a capture binding. It explicitly checks the `ctx.clerkUserId` shape and joins that Clerk identity to the native `users` row on the supplied transaction before invoking the fixed current-memory owner. Completion is read on that same transaction. The capture install calls this seam before its update; the provider-rate Case12 branch calls the current native binding guard before qualification installation.

Compared with `prior-capture-authority.ts`, the refactor moves native corpus plus completion into a reusable pre-install seam, then performs stored-binding and MA510 checks in `assertMeriCase12BindingInTx`. The call sites retain the current binding checks. The narrowed `MeriCase12CaptureBinding` type does not itself replace signed runtime-policy checks: readback first validates the stored policy/receipt pair and current server authority; the provider installer uses the seam for native Case12 source authority and independently fences its settings state. I found no concrete weakening attributable to this type narrowing.

The prior review's exact fixed-recipe/native-helper closure remains controlling for the whole-corpus content guard. I do not reopen the previously rejected changed-content exploit; this review did not identify a change to those guards that supports it.

### Separate provider-rate installation

The Case12 `currentState` branch requires the saved binding to match the requested client and current actor and requires its current verification hash to equal the native current proof. It returns the actual Case12 run/hash and hashes of the current binding and prior qualification, along with the locked tenant row version. Installation compares all four expected fences (current verify, capture binding, prior qualification, tenant row version), validates the qualification against the current Case12/run, validates rate evidence and its hash/expiry/rates, then performs a row-version-fenced write and exact qualification readback. This is distinct from binding installation; no provider price is inferred from HTTP/provider input.

### Signed receipt, exact MA510 read, and message ownership

The readback validates the actual stored policy/receipt pair, including exact policy key set, HMAC verification, receipt-policy identity, Case12 setup tuple, and receipt blocker/status consistency. A passage qualifies only when the receipt has exactly one observation for the native MA510 physical source and its observed tenant/client, current source version, full-read flag, full locator, passage hash, and byte hash match the current native MA510 proof and approved passage. It joins that observation to one complete read-only `search_memory` call, attempt 1, which names the same source, and one returned HTTP-200 invocation with one HTTP attempt and the same call ID. The readback only returns `QUALIFIED` when those checks pass and the signed receipt status is `COMPLETE`; otherwise passage evidence is blocked.

At the actual `MeriService.listMessages` callsite, messages are fetched with tenant, user, and conversation ownership filters. The generic `authorizeMeriCaptureMessageReadback` runs before the Case12 custom reader and checks assistant role, row tenant/user/conversation/client, the owned user turn, current authority, provider-ledger state/hash/admission/limit/turn, and the observed provider-ledger write when a budget receipt is present. Case12 custom readback follows those checks. The supplied exact service hash/excerpts support that ordering; this is not inferred from the mock spec.

The raw signed-positive/full-passage and 16 signed-negative cases are local mocks of native owner/DB boundaries. They use actual HMAC sign/verify logic, but do not prove native DB ownership, native completion, install CAS, or full-native read/install execution. The supplied test log reports 3 suites/64 tests passing for readback and neighboring suites; it is evidence of that recorded mock test run only, not an independent rerun or native PASS.

## Runtime gates and disposition

The supplied prior native attempt hit the real default 5-second hydration transaction blocker (P2028). Current native owner/completion/capture and full native read/install remain NOT_RUN. Budget aggregate, worker/helper census, runtime admission, and the remaining native admission/settlement gates are separate and still required; none is granted by this review. No live authority, readiness, or capture permission is implied.

Final disposition: PASS_SOURCE_ONLY_WITH_RUNTIME_BLOCKER. No concrete frozen-source defect was established within the requested scope. Native hydration/current-owner/completion/capture and installation CAS qualification remain open gates; do not promote this to full-native PASS.