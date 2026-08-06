# Phase 4 — Complete RDT&E Semantics and Certified Cycle Pipeline

> **STATUS: IMPLEMENTATION COMPLETE ON CLOSEOUT BRANCH — NOT MERGED, NOT DEPLOYED**
>
> Phase 4 now runs from the final merged Phase 2 and Phase 3 contracts. The
> complete local closeout matrix must be executed on the exact PR head before
> merge. No test result is claimed by this document unless attached from an
> actual repository runtime.

## Repository posture

```text
Repository: neo-capiro/capirov2
Base: merged Phase 3 main
Branch: agent/pe-rdte-phase4-closeout
Deployment: not performed
Shared migrations: not applied
Canonical writes: not performed
Paid parser calls: not performed by closeout
```

## Final workflow

```text
manual cycle manifest + supplied official source bytes
  → Phase 3 profile, route, execute/replay, compose
  → Phase 4 semantic R-1/R-2/R-2A/R-3/R-4 artifacts
  → exact Phase 2 verification during routing
  → final all-artifact Phase 2 verification
  → evidence-linked R-1/R-2 and project-sum reconciliation
  → manifest/source-ledger coverage
  → proof-bound read-only projection plan
  → final certification carrying the projection-plan content SHA
```

## A–O workstream evidence

| Workstream                         | Closeout status      | Evidence                                                                                                  |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| A — contracts and baseline         | Complete             | final Phase 2 verification reference contract, exact artifact byte/content refs, deterministic bundle IDs |
| B — header/unit/rounding           | Complete             | exact decimal arithmetic and source-unit tolerances retained                                              |
| C — R-1 extraction                 | Complete             | semantic factory runs the existing R-1 extractor with exact parser lineage                                |
| D — R-1 Phase 2 policy             | Complete             | router and final verification pass use the final trusted verifier contract                                |
| E — R-2 segmentation/context       | Complete             | segmenter/context resolver run on selected Phase 3 page results                                           |
| F — R-2 narrative                  | Complete             | identity and narrative are emitted into the R-2 artifact rather than discarded                            |
| G — R-2 funding                    | Complete             | funding artifact merged with complete R-2 semantic artifact; evidence-linked R-1/R-2 comparison           |
| H — R-2A identity/narrative        | Complete             | standalone and embedded R-2A sections supported                                                           |
| I — project funding/reconciliation | Complete             | exact project positions, expected-project denominators, printed-unit sum reconciliation                   |
| J — R-3 performers                 | Complete             | role-honest performers; total cost remains cost analysis, not annual funding                              |
| K — R-4 milestones                 | Complete             | exact dates only when printed; quarter/month/year/text period fidelity retained                           |
| L — cycle certification            | Complete             | exact manifest/source/artifact/verifier binding and required projection-plan SHA                          |
| M — projection/schema              | Complete for Phase 4 | proof-bound read-only plan; additive provenance/relationship/period constraints prepared for Phase 7      |
| N — commands/gates/rehearsal       | Complete             | real annual command, safety gate, 20 mutate-fail-restore controls, PostgreSQL rehearsal                   |
| O — docs/handoff                   | Complete             | annual runbook, this matrix, final acceptance command                                                     |

## Closed audit findings

### Final Phase 2 result contract

Cycle verification references now retain:

- manifest SHA and document key;
- artifact ID, content SHA, and byte SHA;
- candidate ID and verification run ID;
- verifier policy SHA;
- SourceDocument ID and source PDF SHA;
- machine decision and terminal status;
- accepted and rejected assertion IDs.

Certification rejects any mismatch.

### Real Phase 3 integration

The annual command no longer accepts page dumps. It invokes the merged parser
router, supplies a Phase 4 semantic artifact factory, preserves exact parser
runs/page ranges/provider job IDs, and captures unresolved pages.

### Complete R-2 artifact

R-2 identity and narrative are emitted with funding into one strict artifact.
R-2 volumes containing R-2A/R-3/R-4 pages merge those source-bound sections
without inventing separate source documents.

### Exact coverage

Coverage denominators come from manifest-required categories and required source
facts. Observed counts can no longer make missing performers, milestones,
projects, relationships, or funding appear not applicable.

### Evidence-linked comparisons

R-1/R-2 comparisons retain PE, FY, source unit, exact tolerance, artifacts,
assertions, and evidence IDs. Independent printed values use one printed unit,
not binary floats or generic percentage tolerance.

### Certification order

Projection planning is required before final certification. A guarded in-memory
preflight is permitted only when the missing projection plan is the sole
remaining blocker. The final bundle contains the exact projection-plan SHA.

### Projection proof

Production and operator paths use the proof-bound projection wrapper. Every
candidate carries final Phase 2 decision/status/policy/SourceDocument identity
and is checked against the certified bundle before its plan SHA is computed.

### Schema integrity

The forward closeout migration adds:

- original value and unit;
- artifact ID and content SHA;
- assertion ID;
- verification candidate/run/policy;
- source PDF SHA, SourceDocument ID, and evidence IDs;
- composite project foreign key;
- total/base/OCO/quantity position kinds;
- strict schedule-period shapes;
- new provenance indexes.

It is additive and has not been applied to a shared database.

## Operator commands

Annual build:

```bash
pnpm --filter @capiro/api build:rdte-cycle -- \
  --manifest <manifest.json> \
  --source-root <source-directory> \
  --out <cycle-output-directory>
```

Exact source map:

```bash
... --source-map <source-map.json>
```

Explicit bounded paid escalation:

```bash
... --allow-paid-parse --max-paid-pages 12 --paid-mode pdf_premium
```

Read-only projection replay:

```bash
pnpm --filter @capiro/api plan:rdte-projection -- \
  --cycle-dir <cycle-output-directory> \
  --out <plan.json>
```

## Final acceptance matrix

```bash
pnpm --dir apps/api exec tsx \
  scripts/verify-pe-budget-phase-4-closeout.ts \
  --include-containers
```

The matrix includes:

1. merged Phase 1–3 closeout;
2. Phase 4 semantic/cycle/projection/command tests;
3. strict TypeScript;
4. Prisma generation and validation;
5. architecture and operator safety gates;
6. all 20 mutate-fail-restore controls;
7. disposable PostgreSQL 16 fresh/upgrade rehearsal;
8. formatting and `git diff --check`;
9. optional table/layout/OCR container builds.

## Merge and shipping sequence

1. Run the complete closeout matrix on the exact PR head.
2. Attach the command output to the PR.
3. Confirm no P0/P1 findings from an independent review.
4. Squash and merge.
5. During an authorized release window, run the migration rehearsal again.
6. Apply the two additive migrations through normal deployment tooling.
7. Deploy application and parser-container changes.
8. Run a read-only annual build on representative official RDT&E documents.
9. Do not enable canonical writes; Phase 7 owns canonical mutation.

## Explicit exclusions

- automatic source discovery and scheduling;
- production backfill;
- canonical Program Element writes;
- review UI/public review API;
- unrestricted paid parsing;
- deployment performed from this branch.
