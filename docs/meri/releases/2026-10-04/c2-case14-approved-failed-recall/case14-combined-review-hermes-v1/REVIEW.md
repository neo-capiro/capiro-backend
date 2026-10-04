# Case 14 combined spend / approval-provider bound — independent review

## Verdict: BLOCKER for this bounded change

The prospective-spend design and provider ceiling are internally coherent in the reviewed sources, but the exact manifest contains a TypeScript parse error in `apps/api/src/memory/memory-candidate.service.ts:200`. The constructor parameter is literally written as:

```ts
private readonly authorization: MemoryAuthorizationService *** new MemoryAuthorizationService(
```

`*** new` is not valid TypeScript. This prevents the API source from compiling and blocks accepting the bounded change until corrected. This is a concrete defect in the manifest source, not a claim about the tests or any live deployment.

## Spend and provider-bound review

- The native fresh journal keeps its first 24 records as the immutable pre-Case14 prefix. The reducer pins the original 20-record prefix and the exact 24-record Case14 boundary; the prospective Case14 reservation is restricted to sequence 25 and to one non-historical Case14 run. Fresh Case14 is not available through the generic JavaScript `reserve` path.
- The dedicated JavaScript reservation consumes the opaque cost authority from `case14-approval-cost-authority.mjs` and writes one combined 15,000,000-micro-USD ceiling, partitioned as 1,000,000 approval plus 14,000,000 recall. The native reducer checks those exact amounts, rejects replay/duplicate runs, and commits the full ceiling while active. That is consistent with reserving the combined maximum only once.
- Historical known charges stay separate from the conservative approval amount. At the 24-record boundary the native reducer's historical settled total is 13,631,058 micros. A new active Case14 run therefore commits 28,631,058 micros and leaves 1,368,942 micros of the 30,000,000-micro aggregate. At settlement it adds the recall's known settled charge and retains the 1,000,000-micro conservative approval charge; it does not refund the approval reserve or treat unknown approval billing as zero. A later Case14 replay is rejected.
- The stated provider envelope is arithmetically sound under its explicit assumptions: at 8,192 input tokens per provider call and $0.02 per million tokens for each provider, one OpenAI wire attempt plus three maximum Titan SDK attempts costs at most $0.00065536 (656 micros, rounded up). The $1 approval envelope is substantially above that modeled amount. This is a prospective ceiling, not evidence of actual billed cost; unknown billing must not be converted into a refund or a zero charge.
- The bound depends on the reviewed path remaining one direct OpenAI fetch and one governed Titan invoke, with the Titan SDK's resolved `maxAttempts: 3`, those input caps/prices, and no additional provider work or task-initiated maintenance/retry. The authority source binds the exact API image/environment/task definition and the exact nightly rule/target/task definition, checks running API task identity and overrides, rejects relevant active standalone tasks, disables the broad worker, and fences the 15-minute window against the next 04:30 event. The evidence says the nightly rule is enabled; if its currently scheduled task is running, approval must not proceed. This review did not query AWS or otherwise check current live state.
- The evidence's 656-micro figure is a modelled maximum, not a provider receipt or a guarantee of invoice treatment. Keep known actual charges distinct from conservative reservations and require authoritative settled usage before any recall settlement/release.

## Authority, approval route, and failure accounting

The JavaScript spend owner stores reservation capabilities in a `WeakMap`; copied JSON, hashes, or restored proof objects do not recreate those capabilities. The Case14 cost authority is likewise an opaque object held in a `WeakMap`, minted only after the native AWS census, and consumed once by the dedicated reserve path. The native journal's `approvalBoundSha256` is a binding/receipt field, not a substitute for those JavaScript authorities. The native reducer alone checks the field's shape and partition; it does not independently establish AWS authority. The reviewed supported path relies on the JavaScript opaque authority for that authorization distinction.

The ordinary approval collector is limited to the exact reviewer/tenant/candidate and canonical approve route. It performs the pre-intent refresh and reservation assertions, allows one exact `{}` approval POST, immediately consumes the submission gate at the route, records the owned response and before/after state, and binds the resulting outcome to the in-process reservation. Unintended writes are denied/accounted for. A failed or uncertain submission is not made replayable by a proof hash or by a second reservation.

## Live prerequisites — explicitly not satisfied or authorized by this review

- `projectionTerminal` is currently null and no live terminal factory is attached. Consequently, the current aggregate cannot claim/settle the Case14 recall. Root must separately integrate and review a real-DB-read-only ECS receipt authority that proves the exact canonical approved owner, matching vectors/content/models, and completed fast-path outbox with no pending/running/failed sibling.
- The native post-approval outer layer is not yet implemented. It remains a live prerequisite.
- The approval cost authority must be freshly obtained from the native current-AWS census; the source evidence alone does not authorize a submission. In particular, do not approve while the relevant nightly task is running or if any bound identity, task, override, rule, target, or timing check fails.
- These omissions are reported as prerequisites, not as claims that the sources authorize live execution. No external approval request was made. The root's standing human execute authorization does not waive these technical prerequisites.

## Test and execution statement

Root reports that all 19 native tests passed, and reports retaining the legacy tests while integrating the fresh functions and fixing the partition-float checks. I did not run tests and do not independently attest to that result. This review used the provided manifest sources only; it did not access a live environment, invoke AWS, submit an approval, or modify source files.

## Scope of verdict

BLOCKER applies to accepting this bounded change as represented by the exact manifest because of the API TypeScript parse error above. It is not approval to execute Case14. All live prerequisites listed above remain in force even after that source defect is fixed.

## Manifest source identities reviewed

- `evals/meri/live-v1/lib/windows-capture-spend.py` — `d9fefeda594bee5c69eaa596de2d0a41ad8bab7fbfaf8ee3ce2e7d9a4564277d`
- `evals/meri/live-v1/tests/capture-spend-fresh.unit.py` — `bbdd306485ae8cd057fe19a85939ef3973c0ac6040ba053192be39e957205af6`
- `evals/meri/live-v1/capture-spend-aggregate.mjs` — `207173e264edffea41bacc3323b6b10890edc7d17cab1fc860b3803434b719a7`
- `evals/meri/live-v1/case14-approval-cost-authority.mjs` — `bf83036605dc2ceaacede635bbc394cc17d3c769bc64e47d41626b6758edc5c8`
- `evals/meri/live-v1/case14-approval-cost-evidence.json` — `aa63a7378883f152c1d8180cc0796fc5dc2bb4ad61e68df9030d52b9a754aa33`
- `evals/meri/live-v1/case14-approval-capture.mjs` — `cadc7d7533de483d46deb3d28bc621909e3cfca548576d63c2b2fe9a75750ed4`
- `evals/meri/live-v1/case14-approval-write-guard.mjs` — `4aff57265d0fe414221f8d168e53ddd0940bca1ca76c6f86cb2669e7b16d5a34`
- `apps/api/src/memory/memory-candidate.service.ts` — `411f943b59aa74f2791acd68c32b6eae5fec587bf2e2b669e0dadfde0be776ce`
- `apps/api/src/memory/governed-memory-ingest.service.ts` — `122164ca67d8e47d0037a1e1ab2fa606e1ddea036810f42877c1cbe3f63cf612`
- `apps/api/src/memory/strict-memory-projector.service.ts` — `29d580fc0bc8c1a40b08a04a79da5200adca823582e750ad313b7b367693bcf2`
- `apps/api/src/memory/exact-memory-cleanup-outbox.service.ts` — `8b6843696943c30feab19d271680ff2429effcbc8399ea67ee9e7045c365154d`

Note: the manifest also includes the evidence-only `case14-approval-cost-evidence.json`; its reviewed-artifact hash asserted by the authority module is `fac6ae10ca139a3d4dc8583e621c3b5f70b9e72214a05825a988c55964d3f56c`.