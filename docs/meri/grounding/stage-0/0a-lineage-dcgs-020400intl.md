# 0a — FY2027 DCGS / `020400INTL` lineage verification

Scope: every case-insensitive `DCGS` or `020400INTL` match in the repository's FY2027 budget markdown exports. Line numbers are repository line numbers, not source-page locators. Amounts and units below are preserved as printed. The two P-series exports repeat the same USSOCOM PB request material; repetition is not independent lineage evidence.

## PB request: P-1 / P-40

| Export line | Vehicle | What the export says |
| --- | --- | --- |
| `pseries_defensewide_procurement_fy2027.md:74` | PB 2027 P-1 index | Line 62, Intelligence Systems, BLIN `020400INTL`, `319,241` (the table's P-1 amount is $K), P-40/P-40a pp. 175–182. |
| `pseries_defensewide_procurement_fy2027.md:3991` | PB 2027 P-1/P-40 | Heading: “P-1 Line 62 — 020400INTL — Intelligence Systems”; lines 3993–4009 identify BA 02 SOCOM and FY2027 total/request `$319,241K`. |
| `pseries_defensewide_procurement_fy2027.md:4021` | PB 2027 P-40 narrative | The systems procured include “Distributed Common Ground Surface Systems (DCGS) programs” (sentence begins at line 4015 and the DCGS phrase spans 4020–4021). |
| `pseries_defensewide_procurement_fy2027.md:4035` | PB 2027 P-40 header | `0300D: Procurement, Defense-Wide / BA 02: Special Operations Command` and `020400INTL / INTELLIGENCE SYSTEMS`. |
| `pseries_socom_procurement_fy2027.md:37` | PB 2027 P-1 index | Same line 62, BLIN, `319,241` $K, and P-40/P-40a pp. 175–182. |
| `pseries_socom_procurement_fy2027.md:1381` | PB 2027 P-1/P-40 | Same line heading; lines 1383–1399 print FY2027 `$319,241K`. |
| `pseries_socom_procurement_fy2027.md:1411` | PB 2027 P-40 narrative | Same DCGS-program sentence (spans 1410–1411). |
| `pseries_socom_procurement_fy2027.md:1425` | PB 2027 P-40 header | Same 0300D / BA 02 SOCOM and `020400INTL / INTELLIGENCE SYSTEMS` header. |
| `pdoc_army_op_ba2_fy2027_corrected.md:388` | PB 2027 Army procurement document | Separate line `9690BZ7316 — DCGS-A-INTEL`; its table at lines 393–401 prints FY2027 request `$1,075` in `$K` (and FY2025–FY2031 values). |

The P-1 index in both P-series exports also prints a separate uncoded line 63, “Distributed Common Ground/Surface Systems,” at `pseries_defensewide_procurement_fy2027.md:75` and `pseries_socom_procurement_fy2027.md:38`. Their detailed sections (`:4075–4091` and `:1465–1481`) retain FY2025 `3,918` and FY2026 `2,824` ($K), print FY2027 total `$0K`, and say no FY2027 detailed P-series section was found.

## FY2027 authorization marks: HASC / SASC NDAA

These tables print dollars (`$`), not $K.

| Export line | Vehicle | Request | Mark | Delta | Separate line |
| --- | --- | ---:| ---:| ---:| --- |
| `armed_services_hasc_fy2027_procurement_corrected.md:173` | HASC, H.R. 8800 RH, NDAA Div. D §4101 | `$1,075,000` | `$1,075,000` | `$0` | Other Procurement, Army line 46, DCGS-A-INTEL |
| `armed_services_hasc_fy2027_procurement_corrected.md:709` | HASC, same vehicle | `$316,157,000` | `$306,157,000` | `$-10,000,000` | Other Procurement, Air Force line 64, DCGS-AF |
| `armed_services_sasc_fy2027_procurement_corrected.md:173` | SASC, S. 4784 RS, NDAA Div. D §4101 | `$1,075,000` | `$1,075,000` | `$0` | Other Procurement, Army line 46, DCGS-A-INTEL |
| `armed_services_sasc_fy2027_procurement_corrected.md:734` | SASC, same vehicle | `$316,157,000` | `$316,157,000` | `$0` | Other Procurement, Air Force line 64, DCGS-AF |

## FY2027 appropriations marks: HAC-D / SAC-D

| Export line | Vehicle | Request | Mark | Delta | Separate line |
| --- | --- | ---:| ---:| ---:| --- |
| `appropriations_hacd_fy2027_procurement_corrected.md:182` | HAC-D FY2027 Defense Appropriations full-committee print, Title III | `$1,075,000` | `$1,075,000` | `$0` | Other Procurement, Army line 46, DCGS-A-INTEL |
| `appropriations_hacd_fy2027_procurement_corrected.md:720` | HAC-D, same vehicle | `$316,157,000` | `$267,120,000` | `$-49,037,000` | Other Procurement, Air Force line 64, DCGS-AF |

No FY2027 SAC-D export in this repository contains `DCGS` or `020400INTL`. No FY2027 match names DCGS-MC. The FY2027 exports identify the bills/committee vehicles above, but do not include `H. Rept.` or `S. Rept.` publication dates.

## What is established

- The PB request identifies `020400INTL` as P-1 line 62, Intelligence Systems, 0300D Procurement, Defense-Wide / BA 02 SOCOM, with FY2027 request `$319,241K`.
- Its P-40 narrative expressly says the line procures Distributed Common Ground Surface Systems (DCGS) programs among many SOF intelligence systems.
- An uncoded “Distributed Common Ground/Surface Systems” P-1 line 63 retains prior-year amounts but has `$0K` in FY2027 and no detailed FY2027 section in the downloaded justification PDFs.
- Army DCGS-A-INTEL and Air Force DCGS-AF remain separately named and separately numbered FY2027 procurement lines in the request/committee exports listed above.

## What is NOT established

- No excerpt states that line 63, DCGS-A-INTEL, DCGS-AF, DCGS-MC, or any other service DCGS line was consolidated into `020400INTL`.
- The P-40's inclusion of “DCGS programs” establishes a funded component/category within `020400INTL`; it does not identify a predecessor, successor, or `same_program` edge to another coded line.
- A zero FY2027 amount, a changed stage label, proximity in a table, or co-mention in a narrative does not establish lineage.
- Therefore the candidate seed is intentionally empty: these exports support narrative membership, not a budget-line lineage relationship.
