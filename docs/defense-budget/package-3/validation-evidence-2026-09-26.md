# Package 3 bounded mixed-family HASC seam evidence

Date: 2026-09-26 (UTC)

This addendum records a candidate-only implementation increment. It does not
authorize a congressional production manifest, database registration,
historical replay, canonical publication, or activation.

## Implemented seam

- `congressional_stage_packet_v1` is a strict packet envelope limited to the
  HASC authorization stage in this increment.
- The packet carries versioned congressional tables and a native identity
  index/resolution context. The provider binds packet bytes, profile, fiscal
  year, source PDF SHA, source document ID, table pages, and the exact
  persisted parser proof before returning inputs.
- The handoff selects the HASC stage composer only for the tagged stage packet;
  the legacy committee adapter remains isolated and RDTE-only.
- The durable HASC factory derives the parser run from the persisted result,
  composes mixed-family-capable HASC tables, calls the Phase 5 proof boundary,
  and persists immutable artifact bytes only after proof validation.

## Executed gates

| Gate                                             | Result | Evidence                                                                                                        |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| API TypeScript check                             | PASS   | `pnpm --filter @capiro/api exec tsc --noEmit --pretty false`                                                    |
| Parser-router TypeScript scope                   | PASS   | `pnpm --filter @capiro/api exec tsc -p tsconfig.budget-parser-router.json --noEmit --pretty false`              |
| Focused provider/handoff/resolver/durable suites | PASS   | 4 suites / 19 tests                                                                                             |
| Existing Package 3 qualification helper          | PASS   | `qualify:package3-congressional`; `QUALIFIED_ISOLATED_PILOT`, 926 rows, 0 parser failures, no production writes |
| Patch hygiene                                    | PASS   | `git diff --check`                                                                                              |

## Native HASC qualification-only follow-on

The pinned `CRPT-119hrpt698` packet was then converted into 48 native
`congressional_stage_packet_v1` tables containing all 926 reviewed rows. The
fixture still has no independent Phase 4/5 native identity index, so the
resolution context intentionally contains zero entries. The durable HASC
factory therefore emits zero accepted funding assertions and 926 explicit
unresolved omissions while still binding one persisted parser proof and
persisting immutable artifact bytes in disposable storage.

| Gate                                             | Result | Evidence                                                                                                      |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| Native qualification harness suite               | PASS   | 1 suite / 2 tests; parser-result byte SHA and parser-run identity re-read from disposable verified storage  |
| Native stage packet conversion                   | PASS   | 48 tables / 926 rows; schema `congressional_stage_packet_v1`; 0 native index entries                        |
| Fail-closed identity resolution                  | PASS   | 926 unresolved omissions; 0 `hascMark` funding assertions; completeness `incomplete`                       |
| Qualification command                             | PASS   | `QUALIFIED_ISOLATED_PILOT`, `candidateOnly: true`, no production writes; retained result JSON updated        |

## Scope limits

This is an offline/candidate seam. It supports only one persisted parser run
and the HASC stage packet shape. It does not provide a governed production
source registration, an independent native identity index, procurement/O&M/
MILCON/general-provision tables, mixed-family completeness denominator,
independent human review, expected-source manifest approval, lifecycle worker
replay, or publication authorization. Package 3 therefore remains
`NOT_COMPLETE`.
