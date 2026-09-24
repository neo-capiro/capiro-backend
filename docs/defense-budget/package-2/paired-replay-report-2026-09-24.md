# Package 2 Jev paired replay and task-cost report

- Fixture: `jev_task_evaluation_fixture_v1`
- Registry: `jev-task-registry.v4`
- Pinned model identity: `jev-1.13.0`
- Cases: 10
- Deterministic output hash: `b44905cc1820bd0c`
- Label status: proposed
- Provider calls made: 0 (offline replay only)
- Pricing status: unpriced; token and latency metrics are retained without assuming an output-token price

Command:

```text
pnpm --filter @capiro/meriv2-core eval:jev-package2 -- --output tmp/jev-package2-eval
```

| Task | Cases | Jev matched proposed expectation | Operational failures | Abstentions | Input tokens | Output tokens | p95 ms | Over-budget cases | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `program_identity` | 4 | 4 | 2 (`malformed_response`, `timeout`) | 1 | 300 | 44 | 8000 | 0 | unpriced |
| `mention_scope` | 3 | 3 | 0 | 1 | 525 | 65 | 17 | 0 | unpriced |
| `evidence_selection` | 3 | 3 | 0 | 2 | 450 | 54 | 13 | 0 | unpriced |

The cases include an ambiguous alias, an exact-identifier control, a `none` outcome, ambiguous evidence, wrong-organization scope, a provenance-bearing source, malformed output and provider timeout. Failure cases emit no task outcome or action. All Package 2 decisions remain comparison/review artifacts; these proposed labels do not establish accuracy, precision or recall.
