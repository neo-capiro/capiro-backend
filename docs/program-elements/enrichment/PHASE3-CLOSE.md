# PE Enrichment — Phase 3 CLOSE

**Date:** 2026-08-01  
**Branch tip:** `f8dba151c04f334fb81961baa8d67b261b5f6009`  
**PR:** https://github.com/neo-capiro/capirov2/pull/726  
**Env:** sole-live `capiro-dev`  
**Extraction policy:** LlamaParse `pdf_premium` only for PDFs  

---

## Exit criteria (plan Phase 3)

| Gate | Result |
|---|---|
| F: R-1 LlamaParse → commit → replay | **PASS** (Phase 2) |
| F: R-2 LlamaParse → commit | **PASS** Army BA1 + AF Vol1 |
| Marks HASC/SASC/HAC-D exact-SHA commit | **PASS** |
| NDAA conference refresh | **PASS** (FY26 corrected package) |
| Approps `conference` field | **Still 0** — no approps conference artifact this cycle |
| Derive dry-run | **PASS** (Phase 5) |
| LegiWatch paused? | **No** |

## Live promotes (canonical)

| Job | Exit | Outcome |
|---|---|---|
| FY2027 R-1 LlamaParse | 0 | upserted 89 / changed 2831; replay upserted 0 |
| Army RDTE Vol1 BA1 (R-2) | 0 | extract 230 lines / 821 values; commit upserted 18 / changed 568; replay upserted 0 |
| AF RDTE Vol1 (R-2) | 0 | extract 268 / 1233; commit upserted 108 / changed 713 |
| HASC FY27 corrected | 0 | COMMIT ok; rowsEmitted 926; upserted 922; changed 803 |
| SASC FY27 corrected | 0 | COMMIT ok; rowsEmitted 929; upserted 925; changed 796 |
| HAC-D FY27 RDTE marks | 0 | COMMIT; upserted 662; changed 575 |
| NDAA conf FY26 corrected | 0 | COMMIT; upserted 918; changed 808 |

### Key SHAs
| Artifact | sha256 |
|---|---|
| FY2027_r1.pdf | `1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a` |
| Army RDTE Vol1 BA1 | `02f719c0d9d528284a70ec84b5e90e1a6a2008ebc5f610a56236db0a10e112c0` |
| AF RDTE Vol1 | `6666345286e16a60ed4d0d74fd788389eb7565b2225e9d51e262a9ee2a2b20fb` |
| HASC FY27 corrected JSON | `27bd590a7a1a7c0532a5f1cfeb2f8a3d894cff60e24cc0ae4e338fb4914ff096` |
| SASC FY27 corrected JSON | `7b72c3ccd7b4fb4b8fd3990865eb514f629b685d3669459f2faf9ca47c891120` |
| HAC-D FY27 RDTE JSON | `db40e84624847f2b605f8dfd815e159e3d83ce17827ade8d5de4c5abe605caf1` |
| NDAA conf FY26 JSON | `766bf10f99f390b439138866c5017a555ec801351b293a5bb80538bb94efd3eb` |

## Diag delta (baseline → post Phase 3 wave)

| Metric | Baseline | Post P3/P4 |
|---|---|---|
| PE-year rows | 10312 | **10515** |
| request non-null | 8307 | **8511** |
| hasc / sasc / hacD | 3959 / 3961 / 1319 | 3959 / 3961 / 1319 (re-commit; already dense) |
| ndaaConference | 1562 | 1562 (FY26 package refresh) |
| conference (approps) | 0 | **0** (no source) |
| sacDMark | 5 | 5 (no SAC-D package) |
| stale reconciliation | 1131 | **6560** (ownership/value_conflict reviews from multi-source wave) |

## Residuals
1. Approps conference field still empty — needs real JES/conference PDF when published.  
2. SAC-D still thin — no corrected package this wave.  
3. Stale recon count rose (expected from multi-authority writes + request ownership guards).  
4. asafm WAF blocks live Army PDF fetch from laptop; used archived S3 originals.

## Phase 3 status: **CLOSED (PASS WITH RESIDUALS)**
