# PE Enrichment — Phase 4 CLOSE

**Date:** 2026-08-01  
**Tip:** `f8dba151c`  
**Env:** `capiro-dev`

## Exit criteria (plan Phase 4 = WS-G/H depth)

| Gate | Result |
|---|---|
| O-1 / OM load | **PASS** — `om_fy2027.json` COMMIT; pes 389; yearRows 1044; changed 289 |
| OP-5 detail | **PASS** — `om_op5_fy2027.json` COMMIT; seen 278; updated 278 |
| P-doc Army missile | **PASS** via `parse-pdoc` corrected JSON — pesSeen 26; pesChanged 131 |
| Generalized LlamaParse P-doc → PE-year | **Blocked by design** — extract 661 lines / 1812 values but commit refused: “requires at least one RDT&E PE…” (procurement is not PE-year canonical path) |
| Secondary SAM etc. | Not in this wave (non-blocking) |

## SHAs
| Artifact | sha256 |
|---|---|
| om_fy2027.json | `2774f0f327572553bc206e181dd75fb945dfe24c07bac06a34af9d7fb4f09617` |
| om_op5_fy2027.json | `bdae874b53bebaf4faa4bd8688c454b391a9a4189184dad467ff44dc215c09a1` |
| pdoc_army_missile_fy2027_corrected.json | `a2bf57b27201aa5c71799b1efa8af99f5560962db07e5c21358d9c8da8787f7b` |
| Missile_Procurement_Army.pdf (LP extract only) | `e47707f50d29ebf796a3db57877d104001c5679ce783f308ed1cd47cca1107f4` |

## Notes
- Prefer family loaders (`parse-pdoc`, `load-om*`) for procurement/O&M depth; generalized `ingest-defense-budget --commit` is RDT&E-PE gated.  
- LlamaParse still useful for extract-only archive of P-docs.

## Phase 4 status: **CLOSED (PASS WITH RESIDUALS)**
