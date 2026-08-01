# Program Elements — Source Family Coverage Matrix (Phase L / Closeout Phase 7)

**Branch:** `agent/program-elements-final-closeout` (PR #705)  
**Authority:** `packages/shared/src/pe-source-coverage.ts` (`PE_SOURCE_FAMILY_COVERAGE`)  
**Rule:** model-facing and user-facing text must not imply unavailable coverage. Unsupported / blocked families **fail closed** — they cannot write canonical PE year fields.

Status legend:

| Status | Meaning |
|---|---|
| `loaded` | Approved product path may write owned canonical fields |
| `partial` | Some FYs/exhibits loaded; do not claim completeness |
| `unsupported` | No approved parser in this release; **no canonical writes** |
| `blocked` | Waiting on official fixture / authorization; **no canonical writes** |

## Decisions (L1–L7 + core)

| ID | Family | Status | Canonical writes? | Notes / future PR |
|---|---|---|---|---|
| `r1_r2_rdte_jbooks` | R-1/R-2 RDT&E J-books | loaded | yes | Core PE path |
| `p1_p40_procurement` | P-1/P-40 procurement | partial | yes | Remaining P-5/P-21/P-3A depth incomplete |
| `committee_marks_reports` | HASC/SASC/HAC-D/SAC-D marks + report language | partial | yes | Coverage varies by FY/committee |
| `ndaa_conference` | NDAA / authorization conference | partial | yes | Owned when authority maps |
| `defense_approps_conference_jes` | Defense Approps conference / JES | partial | yes | Full JES narrative not claimed complete |
| `full_fydp_projection` | Full FYDP projection | partial | yes* | Outyears must never be labeled the current ask |
| `execution_reprogramming_feeds` | Execution / reprogramming feeds | unsupported | **no** | future PR: `pe-source-execution-reprogramming` |
| `procurement_performer_coverage` | Procurement performers / contractors | partial | yes† | Unmatched dollars stay candidates |
| `milcon_c1` | MILCON / C-1 | unsupported | **no** | future PR: `pe-source-milcon-c1` |
| `reserve_exhibits` | Reserve exhibits | unsupported | **no** | future PR: `pe-source-reserve-exhibits` |
| `p5_p21_p3a_op5_gaps` | Remaining P-5 / P-21 / P-3A / OP-5 | blocked | **no** | One family per future PR after fixture approval |
| `sam_opportunity_personnel` | SAM opportunities + solicitation personnel | partial | **no** | Program context only; procurement POC not lobby target |

\* FYDP columns on loaded lines may exist; reconstruction across accounts is not guaranteed.  
† Performer linkage is not a PE year dollar write; observed awards remain evidence-classed.

## Fail-closed enforcement

- `sourceKeyForbiddenForCanonical(sourceKey)` in `@capiro/shared`
- Wired into `authorityForSource` / `mayOwnCanonicalField` (apps/api PE writer ownership)
- Empty report-language tool note includes `peSourceCoverageModelCaveat()`
- Defense-budget domain primer forbids implying unsupported families are loaded

## Non-goals (this PR)

- No new unreviewed parsers
- No MeriV2 source edits
- No shared-env migration / ingestion commit
- Future source-family work is **one family per PR**, non-blocking for the trust-foundation release
