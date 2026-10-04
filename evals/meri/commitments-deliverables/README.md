# Commitments & Deliverables observation checks

These diagnostic checks cover CD-01 through CD-07 and all six Monday variants in the [original extension](../commitments-deliverables-extension.md). They validate the completeness and consistency of recorded observations. They do not authenticate evidence or award a product pass.

Run the portable tests from the repository root:

```sh
node --test evals/meri/commitments-deliverables/cd-acceptance.test.mjs
```

Inspect one saved observation:

```sh
node evals/meri/commitments-deliverables/cd-acceptance.mjs --case CD-02 --observation observation.json
```

The test fixtures define the observation contract. It includes scoped citations and source versions, source coverage and pagination, explicit effects, the benchmark clock, commitment classifications and evidence, trace visibility, and case-specific launch, deduplication, approval/retry, board-access and durable-record joins.

The CLI exits 1 for invalid observations and 2 for unverified evidence or invalid arguments. Even a valid synthetic observation exits 2. `validateCDObservation` returns diagnostic validity; `evaluateSavedCDCapture` adds evidence-reference readiness and always returns `productPass: false`. Caller-authored JSON and references cannot prove access, source accuracy, UI behavior or durable effects.

An actual configured Hermes implementation was corrected after two failing draft tests and additional negative examples. The final portable suite passed 64 checks; six additional local checks of the current compiled registry/API procedure and exact orchestrator guard also passed. Those six used controlled current-row resolution and did not contact a server or database. Root independently reran all 70. No live CD case was accepted, and the original case assertions remain unchanged.
