# Phase 4 generic terminalization fence — local source qualification

Date: 2026-09-26

Branch: `integration/meri-provisional-346-20260925`

## Outcome

The two legacy terminalization paths that could misclassify a Phase 4 UNKNOWN dispatch are now fenced by the durable no-copy intent state.

- An explicit Stop on an unbound run with a `prepared` or `claimed` Phase 4 intent remains `cancelling`. It cannot finalize until the future ownership-fenced reconciler recovers the reservation/worker id or obtains an authenticated `sealed_absent` result.
- A legacy run with no Phase 4 intent still finalizes as before.
- A Phase 4 run with an authenticated `sealed_absent` intent may finalize because durable authority has established that no worker reservation exists.
- The global stuck-pending sweep now excludes `prepared` and `claimed` Phase 4 intents inside the same SQL `UPDATE ... NOT EXISTS` statement. There is no select/update gap for claim or prepare to cross.

This is a safety fence, not a reconciler. It activates no Phase 4 route and makes no claim that absence has been proven for any existing run.

## Evidence

- Phase 4 recovery selection: 6 suites, 46/46 tests passed.
- Focused terminalization fence: 7/7 passed.
- In-memory run-store regression: 16/16 passed.
- Recovery targeted TypeScript passed.
- `git diff --check` passed.

## Remaining boundary

Unknown worker-id recovery still needs an authenticated native reservation lookup plus all-ingress closure proof before `sealAbsent` can transition. Claimed rows need durable late-id status/Stop recovery to terminal. Reconciler ownership, broker-effect receipts, production credential/topology/durability/rollback qualification, Phase 5/6, and explicit deployment GO remain.
