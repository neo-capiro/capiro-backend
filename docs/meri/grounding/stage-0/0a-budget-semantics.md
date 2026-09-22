# 0a — Defense-budget claim semantics

Stage 0 represents every model-facing Program Element (PE) dollar as a `FundingClaim`. Values are canonical USD millions; zero is present data, not missing data. User-visible additions are controlled by `MERI_EVIDENCE_ACCURACY_MODE` and tenant/surface enrollment.

Program-line identity and lineage are separate from dollar semantics. See
[`0a-lineage-dcgs-020400intl.md`](./0a-lineage-dcgs-020400intl.md) for the FY2027
source verification showing why a stage change or narrative co-mention cannot establish consolidation.

## Fields

| Field | Meaning |
| --- | --- |
| `enactmentStatus` | `enacted` only for an enacted-stage claim; `not_enacted` for current/outyear non-enacted stages; otherwise `unknown`. It does not predict enactment. |
| `vehicleType` | `budget_request`, `authorization`, or `appropriation`, derived only from stage. An unmapped stage is `unknown`. |
| `originalUnit` / `originalValue` | The source's printed unit (`dollars`, `thousands`, or `millions`) and amount. They are nullable and never reconstructed from the canonical value. |
| `source` | Winning source identity: document id/type/cycle, publisher, URL, page, and observation timestamp. Every member is nullable; missing provenance is not invented. |

## Derivation table

`vehicleType` is independent of cycle class. `enactmentStatus` is derived from both stage and cycle class:

| Stage | Vehicle type | historical | current | outyear | unknown cycle |
| --- | --- | --- | --- | --- | --- |
| `request` | `budget_request` | `unknown` | `not_enacted` | `not_enacted` | `unknown` |
| `hasc`, `sasc`, `ndaa_conference` | `authorization` | `unknown` | `not_enacted` | `not_enacted` | `unknown` |
| `hacd`, `sacd`, `appropriations_conference` | `appropriation` | `unknown` | `not_enacted` | `not_enacted` | `unknown` |
| `enacted` | `appropriation` | `enacted` | `enacted` | `enacted` | `enacted` |
| `none` (unmapped/no stage) | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` |

Cycle class compares the claim FY with the latest mark-bearing current-cycle FY: lower is historical, equal is current, higher is an outyear projection, and missing context is unknown.

## Tool output matrix

| Tool | off / shadow output | enforce output |
| --- | --- | --- |
| `search_program_elements` | Legacy claim shape; an unmapped finder stage produces `currentFundingClaim: null`. | Adds enactment, vehicle, provenance fields when available, and `semantics`; an unmapped stage is an explicit `none`/unknown claim. |
| `get_program_element` | Recomputes the legacy claim from each year's appropriations ladder; ignores any attached provenance claim. | Prefers the read-service claim (preserving provenance), falls back to the ladder, and adds deterministic `semantics`. |
| `get_pe_budget_timeline` | Same legacy ladder behavior and shape. | Same provenance-preserving enforce behavior as detail. |

`shadow` returns legacy output. It emits one `meri.evidence_accuracy.shadow` warning per PE tool call. The PE-tool event has `tool`, `peCode`, `claims`, `unknownEnactment`, and `withSource`. Search computes its counters from enforce-mode candidate claims, so unmapped stages count under `unknownEnactment` even though legacy output remains null.

Engagement evidence generation uses the `outreach` assurance surface because it prepares outreach drafts. In enforce mode, a PE packet's `authoritativeAsOf` is the newest winning source observation or source-document download; `asOfBasis` is `source_observed`, or `unknown` with a null date when no provenance exists. Off mode retains the legacy fiscal-year-start date and omits `asOfBasis`. Shadow keeps the legacy packet and logs the enforced date/basis.

## Fixture before / after

Given FY2027 request `$10M`, HAC-D mark `$8M`, and a winning R-2 source printed as `8,000 thousands` on page 9:

```json
// off (and shadow payload)
{"value":8,"fiscalYear":2027,"stage":"hacd","stageLabel":"HAC-D","legislativeVehicle":"appropriations","cycleClass":"current","isProjection":false,"unit":"USD millions"}

// enforce
{"value":8,"fiscalYear":2027,"stage":"hacd","stageLabel":"HAC-D","legislativeVehicle":"appropriations","cycleClass":"current","isProjection":false,"unit":"USD millions","enactmentStatus":"not_enacted","vehicleType":"appropriation","originalUnit":"thousands","originalValue":8000,"source":{"sourceDocumentId":"doc-r2","documentType":"R-2","budgetCycle":"PB27","publisher":"Department of the Air Force","sourceUrl":"https://example.test/r2.pdf","pageNumber":9,"observedAt":"2026-04-03T00:00:00.000Z"},"semantics":"stage=HAC-D (appropriation vehicle) FY2027 $8M (source printed in thousands) enactment=not_enacted source=R-2/Department of the Air Force p.9"}
```

For a finder fixture with stage `mystery`, off/shadow return `currentFundingClaim: null`; enforce returns stage `none`, unknown enactment/vehicle, and semantics beginning `stage=unmapped`.
