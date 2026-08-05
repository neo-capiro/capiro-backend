# RDT&E Phase 4 Annual Build Runbook

## Status

Phase 4 is a read-only extraction, verification, reconciliation, certification,
and future-projection planning workflow. It performs no canonical Program
Element writes.

## Preconditions

1. Phase 1 extraction contracts are merged.
2. Phase 2 trusted verification is merged.
3. Phase 3 parser-router closeout is merged.
4. The operator has an explicit cycle manifest and local copies of each source
   PDF.
5. The isolated parser runtime is installed through `uv`.
6. Paid parsing remains disabled unless the operator explicitly enables and
   caps it.

## Source resolution

The annual command accepts either a source root or an exact source map.

### Source root

Each manifest `sourceLocator` must have a deterministic filename present under
`--source-root`.

```bash
pnpm --filter @capiro/api build:rdte-cycle -- \
  --manifest ./manifests/fy2027-rdte.json \
  --source-root ./sources/fy2027 \
  --out ./.work/rdte-fy2027
```

### Exact source map

Use a source map when local filenames differ from the manifest or when an
explicit SourceDocument ID should be retained in the build report.

```json
{
  "army_r1": {
    "sourcePath": "C:/budget/fy2027/army-r1.pdf",
    "sourceDocumentId": "00000000-0000-0000-0000-000000000001"
  },
  "army_r2": "C:/budget/fy2027/army-r2-volume.pdf"
}
```

```bash
pnpm --filter @capiro/api build:rdte-cycle -- \
  --manifest ./manifests/fy2027-rdte.json \
  --source-map ./source-map.json \
  --out ./.work/rdte-fy2027
```

The command recomputes every source SHA from bytes. A manifest
`expectedSourceSha256` mismatch is terminal.

## Executed workflow

```text
manifest + supplied source bytes
  → local execution manifest with exact source paths and SHAs
  → Phase 3 full-document profile
  → deterministic local-first parser routing and verified replay
  → Phase 4 family-specific R-1/R-2/R-2A/R-3/R-4 artifact factory
  → Phase 2 inspect verification during parser rounds
  → final stable artifacts
  → final Phase 2 pass with every other artifact independently proved
  → evidence-linked cross-exhibit reconciliation
  → manifest-derived category coverage
  → guarded, proof-bound projection planning
  → final cycle certification carrying the projection-plan SHA
```

The old `--pages-dir` and `--verifications` inputs are rejected. The command
never accepts a hand-authored passing verification reference.

## Paid parsing

Paid parsing is disabled by default.

```bash
... --allow-paid-parse --max-paid-pages 12 --paid-mode pdf_premium
```

Requirements:

- `--allow-paid-parse` must be explicit;
- `--max-paid-pages` must be a positive integer;
- only exact unresolved pages are submitted;
- verified replay occurs before a provider call;
- no automatic provider retry occurs;
- the annual closeout command never invokes a paid provider.

## Output directory

```text
<out>/
  execution-manifest.json
  artifacts/
    <document-key>.extraction-v1.json
  parser-artifacts/
  work/<document-key>/
    runtime/
    artifacts/
    execution-report.json
  cycle-bundle.json
  projection-plan.json        # only when projection planning succeeds
  build-summary.json
```

`cycle-bundle.json` binds:

- exact manifest SHA;
- source document ID and source PDF SHA;
- parser-run IDs and unresolved-page ledger;
- artifact ID, content SHA, and byte SHA;
- Phase 2 candidate/run/policy/decision/status;
- accepted and rejected assertion IDs;
- evidence-linked comparisons and coverage;
- projection-plan content SHA;
- final certification and findings.

## Exit codes

```text
0  CERTIFIED_RDTE_READY_FOR_PROJECTION
2  NEEDS_REVIEW
3  INCOMPLETE
4  REJECTED
5  argument, parser, proof, or operational failure
```

A nonzero result still writes the available audit artifacts where possible. It
does not authorize canonical mutation.

## Reporting and projection replay

```bash
pnpm --filter @capiro/api report:rdte-cycle -- \
  --cycle-dir ./.work/rdte-fy2027
```

```bash
pnpm --filter @capiro/api plan:rdte-projection -- \
  --cycle-dir ./.work/rdte-fy2027 \
  --out ./.work/rdte-fy2027/projection-plan-replay.json
```

The standalone planner is proof-bound and refuses uncertified or mismatched
bundles. It never accepts `--commit`.

## Migration procedure

Phase 4 has two additive migrations:

```text
20260817010000_rdte_phase4_projection_schema
20260818010000_rdte_phase4_closeout_constraints
```

The second migration adds explicit projection provenance, the project foreign
key, allowed base/OCO position kinds, and strict schedule-period shape checks.

Do not apply either migration to a shared environment during code review.
Before deployment, run:

```bash
bash apps/api/scripts/rdte-phase-4-migration-rehearsal.sh
```

The rehearsal uses disposable PostgreSQL 16 and proves both an empty database
and a pre-Phase-4 upgrade path.

## Final acceptance

From repository root:

```bash
pnpm --dir apps/api exec tsx \
  scripts/verify-pe-budget-phase-4-closeout.ts
```

Including Phase 3 table/layout/OCR container builds:

```bash
pnpm --dir apps/api exec tsx \
  scripts/verify-pe-budget-phase-4-closeout.ts \
  --include-containers
```

The closeout command performs no paid call, shared migration, deployment, or
canonical write.
