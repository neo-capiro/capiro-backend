# Authorization ledger — reconciled 2026-09-20

Two records disagreed. The 2026-09-19 closeout ledger listed six broker-path authorization defects as
open; a later handover claimed "A3–A7 broker-gate fixes" had landed. Nobody had checked which was
true, and the Phase 1 verdict rested on it.

**Method: read the code, not the documents.** Each claim below was resolved against the current source
at `56d97272` with a decisive `path:line`. Two of the six — the ones where the verdict *changed* from
the ledger, and the one that is a live security gate — were then independently re-read rather than
accepted from the audit.

## Result

| # | Claim (as the ledger stated it) | Verdict | Decisive evidence |
|---|---|---|---|
| 1 | **F-1** — read authorized just before revocation still released data; `?? run` fallback silently validates the stale entry-time snapshot | **FIXED, tested** | `meri-hermes-broker.service.ts:204-213` re-reads the run and throws `run_not_live` when absent. **There is no `?? run`.** Release checks precede return in `recall` (`:371-387`) and `getAttachment` (`:461-500`). Regression: `meri-hermes-broker-tool-gate.spec.ts:481-527`; revocation path `meri-hermes-full-application.e2e.spec.ts:1958-1988` (B1) |
| 2 | **F-2** — a newly authorized attempt reused the fenced attempt's Hermes session | **FIXED, with a deliberate fail-soft; failure branch untested** | `meri-hermes-runtime.adapter.ts:686-721` clears `sessionId` and bumps `sessionEpoch`; next dispatch uses the cleared binding and an epoch-derived key (`:486-512`, `:1893-1897`). Regression: e2e `:2015-2053` (B4). **Residual:** invalidation is `.catch()`-logged at `:653-660`, so if it fails the next attempt can still be handed the old session. That is a *documented choice*, not an oversight — the comment states a failure must not stop the fence landing, since "a run left live would be strictly worse." Logged at error level, so observable. No test covers the failure branch |
| 3 | **`assertTool` fails open on an empty allow-list** (`policy.allow.length &&` short-circuits, so `allow: []` permits every tool); and zero specs reference the four refusal codes | **FIXED, tested — and the ledger's second sub-claim was wrong** | Predicate is now unconditional: `if (!policy.allow.includes(tool)) throw ... 'tool_not_allowed'` (`meri-hermes-broker.service.ts:325-330`) — **independently re-read and confirmed**; the `policy.allow.length &&` short-circuit is gone, so an empty allow-list now denies everything, matching the contract at `hermes-runtime.contracts.ts:23-31`. All four codes *do* appear in specs (`meri-hermes-broker-tool-gate.spec.ts:220,249,300,357`), empty-list regression at `:215-225` |
| 4 | **Tool budget non-atomic** — `brokerCalls` mapped as a plain SET, so the 40-call cap is bypassable concurrently | **FIXED, tested** | One guarded atomic statement: `SET broker_calls = broker_calls + 1 ... WHERE broker_calls < limit RETURNING` (`meri-hermes-prisma-run-repository.ts:385-407`), consumed as a reservation at `meri-hermes-broker.service.ts:334-344`. Not Prisma's `{ increment: 1 }` as the ledger anticipated, but stronger — the cap is enforced in the same statement. Regression: real-Postgres 12-concurrent-vs-5-limit test at `meri-hermes-broker-tool-gate.spec.ts:405-453` |
| 5 | **`MUTATING_TOOLS` is a hand-maintained two-element set**, so a new write tool is read-only-permitted by default | **FIXED, tested** | The set is gone except from historical comments. Replaced by an exhaustive `Record<MeriHermesBrokerTool, MeriHermesToolEffect>` (`hermes-runtime.contracts.ts:93-108`) that **fails closed on unknown tools** (`:110-118`). A newly added tool now cannot compile without a classification. Regressions at `meri-hermes-broker-tool-gate.spec.ts:282-320` |
| 6 | **`ContextPlaneRecallPort` receives `authorizedClientIds` and never reads it** | **STILL OPEN** | `meri-hermes-recall.ports.ts:34-40` admits in comment that Context Plane does not use it; `recall()` forwards only query/client/limit (`:83-93`). The parameter is consumed only by the prototype port (`:153-177`). **Concrete failure:** the frozen envelope excludes client X, the caller supplies `clientId=X`, Context Plane independently authorizes X, and records outside the run's envelope are returned. No envelope-enforcement regression test exists |

## What this means

**Five of six are closed; four of those cleanly.** The ledger was substantially out of date, and one of
its sub-claims ("zero specs reference `tool_not_allowed`/`tool_denied`/`read_only_run`/
`tool_budget_exhausted`") was simply wrong — all four are referenced.

Two things remain, and they are different in kind:

- **F-2's fail-soft** is an accepted engineering tradeoff with an error log, not a defect. What it
  lacks is a test on the failure branch. Worth adding; not a blocker.
- **Claim 6 is a real, open authorization gap** and the one to act on. It was already tracked as Phase 2
  item **P2-02**. Until it is closed, **the production recall rail must not be described as
  envelope-enforced** — the envelope is passed and ignored.

## Caveat on method

These verdicts come from reading the current source and the named regression specs, not from executing
them. The specs cited were located and read; they were not re-run as part of this reconciliation. The
converged suite (`jest src/meri/hermes`, 23 suites / 209 tests, exit 0) does pass and includes
`meri-hermes-broker-tool-gate.spec.ts`, which carries the regressions for claims 1, 3, 4 and 5.
