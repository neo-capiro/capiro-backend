# Queued C1 repair: Office Delta triggers an unrelated budget warning

Owner: lead implementation agent. State: QUEUED, not implemented or deployed by C0.

The fresh case03 asks about outreach to Office Delta. The served answer appropriately withholds an unsupported recommendation, then appends: “A delta is valid only between positions with the same fiscal year, funding scope, units, and compatible vehicle stages”. [Saved reproduction](../fresh-live-benchmark/case03-capture/messages-after.json), [source diagnosis](../fresh-live-benchmark/case03-review.json).

The evidence planner in `packages/meriv2-core/src/assurance/evidence-plan.ts` treats the standalone word `delta` as a budget comparison without requiring financial context. `apps/meriv2-orchestrator/src/meri/retrieval/meri-evidence-requirements.ts` turns that unresolved requirement into a footer. Repair only that classification boundary first; preserve useful warnings for actual missing financial comparisons and actual failed source reads.

Qualification must retain the saved reproduction, add negative proper-name coverage and positive real-budget-delta regressions in the existing planner/coverage suites, run the existing 26-case offline evaluation and affected orchestrator checks, and obtain independent review. Use the inspected package scripts (`pnpm --filter @capiro/meriv2-orchestrator test`, `typecheck` and the existing core tests); confirm exact test selection and dependencies in the implementation checkout. No new benchmark framework is needed.

Then verify the repaired behavior through the ordinary served route, using a bounded authorized run and a persisted response. Keep synthetic guard rejections distinct from provider failures. Continue the original C1 checklist: concise no-tool reply; known/zero task reads; known/zero mail reads; controlled mail failure; persisted reload; truthful local coverage and timing. A real mailbox503 still needs reproduction at its actual boundary before selecting a database/query/adapter repair.

Expected release scope: orchestrator image containing the narrow shared-core fix, with current API515 and WebVNext388 retained. Confirm actual downstream imports before finalizing scope. Existing baseline/rollback: orch105 at `sha256:85162728a9d268b797e1f264bde9eb129fb4a170304a6547b3da7a9561d628fa`, source `7c04ca368fbccc84d33c720ce7a20b9201bf6e99`, configuration hash `3a4fabd2139e347cd8b45192579f2a3fbaaa6fc3678762b5252f727a4461951b`. Requalify the exact candidate and use the established release path; no deployment is performed or inferred from this queue entry.

Separately, C2 must address case02's pending-governance-state omission. Before calling the original fixture fully preflighted, implement and qualify the frozen semantic-clock binding described in [fixture blockers](fixture-blockers.json), keeping authentication, leases and execution deadlines on real time. These are retained requirements, not waived assertions.
