# Congressional-to-Enacted Defense Budget Ingestion V1

## Purpose

Phase 6 completes the defense-budget lifecycle after the President's Budget request corpus. It turns congressional authorization, appropriations, conference, enactment, reprogramming, and execution sources into independently provable, noncanonical artifacts and projections.

Phase 6 does **not** promote product truth. Canonical persistence remains Phase 7.

## Lifecycle and field ownership

| Track | Stage | Owned position field |
| --- | --- | --- |
| Authorization | HASC | `hascMark` |
| Authorization | SASC | `sascMark` |
| Authorization | NDAA conference | `ndaaConference` |
| Appropriations | HAC-D | `hacDMark` |
| Appropriations | SAC-D | `sacDMark` |
| Appropriations | Appropriations conference | `conference` |
| Appropriations | Public law | `enacted` |
| Appropriations interim | Continuing resolution | no full-year line position unless explicit line authority is proved |
| Post-enactment | Reprogramming | `reprogrammed` only from an explicit revised total or governed exact derivation |
| Post-enactment | Execution | `executed` only for the exact metric declared by the source profile |

Authorization and appropriations conference are separate vehicles. `ndaaConference` and `conference` are never interchangeable. Later-stage sources never acquire `request` ownership.

## Native identities

All stage positions bind through the Phase 6 native resolver:

- RDT&E: exact PE code.
- Procurement: component + account + BLIN + base/advance status.
- O&M: component + account + SAG.
- MILCON: component + project code + location when represented.

Title-only matches are candidates. Missing procurement account context cannot be guessed. Candidate, unresolved, and conflicting identities cannot machine-pass.

## Table semantics

Column meaning comes from printed headers, never column position. Quantity is never money. A missing unit is never inferred from magnitude. Duplicate rows are preserved; unequal repeated totals are conflicts, not last-wins updates.

Only absolute-position rows may produce stage totals. Adjustment/transfer/rescission rows remain typed actions. An action row carrying an absolute-total semantic is rejected as uninterpretable rather than reclassified.

## Typed non-total actions

`defense_budget_stage_action_v1` preserves increases, decreases, transfer pairs, rescissions, realignments, undistributed adjustments, general provisions, restrictions, directives, reporting requirements, and other reviewed actions.

Actions are separate from absolute funding positions. Multiple actions are never silently netted. Explicit transfers require source and destination identities plus a transfer-group identifier. When baseline/change/after are all printed, exact decimal arithmetic and original-unit consistency must reconcile them.

Report language is linked to actions through shared source evidence; a language/action relationship without intersecting evidence cannot pass.

## Appropriations conference proof

An appropriations conference artifact requires:

- appropriations track and `appropriations_conference` authority;
- exact bill/report identifiers;
- current source-document ID and SHA;
- an explicit standalone/minibus/omnibus vehicle profile;
- division/title scope when applicable;
- a primary `conference_report` source;
- optional Joint Explanatory Statement proof as a separate companion.

The conference amount must be printed. It is never inferred as a midpoint or arithmetic compromise of HAC-D and SAC-D. Missing chamber comparison is `NOT_RUN`, never zero.

## Enactment proof

`DefenseBudgetEnactmentProofV1` is mandatory for every `enacted` position. A public-law label by itself is not proof.

Supported proof types:

1. direct statutory line item;
2. incorporated explanatory statement;
3. incorporated table;
4. other governed-reviewed proof.

Direct statutory proof requires the public law itself to be the exact line-detail source. Incorporated proof requires a separately hashed line-detail source, statutory incorporation evidence bound to the exact public-law source, and an independently trusted public-law reference artifact during verification. Pending, rejected, stale, superseded, cross-FY, wrong-division, or candidate-identity proof cannot support `enacted`.

A continuing resolution remains an interim package record unless explicit line authority is independently proved.

## Reprogramming and execution

Reprogramming records preserve control number, status, date, FY, source/destination identities, amount, before/after values, purpose, and evidence. Transfer actions remain separate even when a revised total is available. A `reprogrammed` position requires either an explicit after-value or a policy-authorized exact derivation in the same printed unit.

Execution records preserve:

- exact metric (`obligations`, `outlays`, `expenditures`, `disbursements`, `commitments`, or governed `reviewed_other`);
- as-of date;
- budget fiscal year;
- amount and unit;
- source system/document/SHA;
- evidence IDs;
- cumulative-versus-period semantics.

Different metrics are never collapsed into a generic execution value.

## Projection and persistence boundary

Phase 6 outputs use `phase6_native_projection_v1`. Every projection carries verification IDs, artifact IDs/hashes, source-document proof, profile hash, native-identity hash, track/stage/field, exact money/original unit where applicable, direct/derived status, evidence IDs, binding status, projection status, and enactment-proof ID when required.

The database schema under `apps/api/prisma/phase6-projection/` is **audit/projection only** and isolated from canonical product tables. Proof/provenance fields are immutable. Projection deletion is forbidden, certification rows are insert-only, and a conflicting live natural key fails instead of overwriting.

## Trusted verification

The shared Phase 2 verification registry includes:

- NDAA conference exact HASC/SASC reconciliation;
- appropriations conference exact HAC-D/SAC-D reconciliation and vehicle proof;
- enacted two-source proof enforcement;
- existing field ownership, evidence, completeness, identity, duplicate, numeric, parser/archive, and arithmetic rules.

Missing required comparisons return `NOT_RUN`; they never become zero and never silently pass.

## Permanent gates

Phase 6 closeout includes the plan-defined NC01–NC24 source-mutation controls. Each control mutates production source, runs its focused permanent test, requires failure, restores the source byte-for-byte, and the runner finishes by executing the full clean negative-control suite.

The golden corpus covers HASC, SASC, NDAA conference, HAC-D, SAC-D, appropriations conference, direct statutory enacted, incorporated explanatory enacted, reprogramming, execution, all four native line kinds, mixed units, quantity, transfers/rescissions, and review/blocking edge cases.

## Closeout guarantees

Phase 6 is complete only when:

- isolated projection Prisma generate/validate passes;
- strict Phase 6 TypeScript passes;
- stage, Phase 6, and shared verification Jest suites pass;
- all 24 production-source mutations are detected and restored;
- architecture scans prohibit canonical writers, legacy parser bases, last-wins/positional mark logic, product provision writes, and direct paid-parser calls;
- Prettier passes on the Phase 6 surface and documentation;
- Ruff, mypy, and the full Python parser pytest suite pass;
- disposable PostgreSQL fresh, replay, upgrade, constraint, rollback, idempotency, and immutability rehearsal passes;
- `git diff --check` and the working tree are clean.

See `docs/runbooks/defense-budget-stage-cycle-v1.md` and `docs/runbooks/defense-budget-enactment-proof-v1.md` for operator procedures.
