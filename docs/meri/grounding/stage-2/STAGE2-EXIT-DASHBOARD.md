# Stage 2 exit dashboard

Live canary status: **PENDING**. Test/replay evidence does not satisfy the live exit gate.

| Criterion | Evidence source | Status |
| --- | --- | --- |
| Completion outcomes acceptable | `meri.canary.turn`; report `current.outcomes` | PENDING |
| Clarification delta ≤ 2 percentage points | baseline/canary report `clarificationRateDeltaPp` | PENDING |
| Holds = 0 | report `limits.holds`, `current.holds` | PENDING |
| Promoted-category repair succeeds | report `current.repair`; `meri.auto_correction.*` | PENDING |
| Required passage retention = 1.0 | report `passageRequiredRetention` | PENDING |
| Contradictory evidence retained | canary event `contradictoryRetained`; passage event | PENDING |
| Coverage follow-ups bounded, residuals disclosed | report `coverageFollowUps`; `meri.coverage.turn` | PENDING |
| Repair p50 ≤ 3s and p95 ≤ 8s | report repair latency limits | PENDING |
| Time-to-text p95 delta ≤ 4s | report `timeToTextP95DeltaMs` | PENDING |
| Cost per completed turn delta ≤ 40% | report `costPerCompletedTurnDeltaPct` plus adjudicated correctness | PENDING |
| Provider failure remains useful fallback | canary outcomes and capability fallback events | PENDING |
| Human prerequisites approved | release record: labels, categories, API key/CDK opt-in | PENDING |
