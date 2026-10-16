# Phase 1–7 retained replay fixtures and source provenance

The executable Defense runtime and its regression specs have one canonical source owner in `apps/api/src`. The duplicate TypeScript trees were removed after proving all 727 file modes, Git blobs and working-tree bytes matched their canonical twins, including 317 retained canonical specs. The source retirement manifest is `scripts/lib/defense-runtime-source-retirement.json`; its immutable baseline and source tree hashes remain recoverable in Git.

All pre-existing non-code files stay here: 15 JSON files, two PDFs and the nested Procurement README. Nine JSON fixture paths are still read by the inspect adapters and their tests. Their paths and bytes are unchanged; both source verifiers check the retained data against its pinned digest and canonical copy. This directory remains outside compilation and the HTTP image. The compiled composition boundary remains in `apps/defense-api/src/runtime`.

## Canonical source ownership

- `apps/api/src/defense-budget`: contracts, parser routing, extractors, verification, composition, projection, certification and promotion inspection;
- `apps/api/src/program-element/{snapshot,source-document,deltas}` and `program-element-change-outbox.service{,.spec}.ts`: snapshot, source, delta and outbox lineage.

`scripts/verify-phase8-session4.mjs` and the compatibility entrypoint `scripts/verify-defense-budget-mirror-parity.mjs` independently rederive the baseline file inventory, require each canonical owner/spec, reject copied executable source here, and preserve all data/fixture checks. The compiled Session 4 runtime manifest keeps its existing contract and historical mirror lineage fields; the new source ownership manifest records the active storage model.

The existing `retained` and `moved` inspect options still select two fixture roots through the same fixture/hash adapter. Their matching artifacts establish fixture-byte and inspect-lineage agreement, not execution of two independent runtime implementations or a real parser pipeline. Existing replay, stage-order, malformed-input and missing-fixture tests retain those assertions.

## Canonical operator entrypoints

Phase 6 composition and Phase 7 planning/status commands remain in
`apps/api/scripts/{phase6-stage-cycle,plan-defense-budget-promotion-v1,status-defense-budget-promotion-v1}.ts`.
Their API package commands, dispatcher, image inputs and working-directory
requirements are unchanged. This mirror carries no duplicate `operators/` tree;
the Session 4 verifier requires those canonical files and rejects copied CLIs.
Canonical runtime, outbox and spec ownership is checked against the immutable
retirement inventory; dual-root FY27 fixture bytes retain parity checks.
This source ownership change does not retire an operator command
or qualify production decommission.

## Deliberately excluded from the HTTP task

- canonical promotion execution and snapshot activation credentials;
- deterministic parser worker process ownership;
- NVIDIA/GPU runtime;
- schema migration authority;
- production schedules or traffic routing.

The canonical `apps/api` implementation, tests and operator commands remain. Removing a copied implementation does not authorize retiring those capabilities, changing runtime ownership, or declaring shadow/canary/rollback/decommission acceptance. Historical acceptance documents and fixture replay records remain unchanged.
