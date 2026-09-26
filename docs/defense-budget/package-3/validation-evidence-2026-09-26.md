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

## Scope limits

This is an offline/candidate seam. It supports only one persisted parser run
and the HASC stage packet shape. It does not provide a governed production
source registration, mixed-family completeness denominator, independent human
review, expected-source manifest approval, lifecycle worker replay, or
publication authorization. Package 3 therefore remains `NOT_COMPLETE`.
