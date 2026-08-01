# PE Enrichment — Phase 2 CLOSE

**Date:** 2026-08-01  
**Branch:** `agent/pe-enrichment-r1-llamaparse-mapper` @ `f8dba151c04f334fb81961baa8d67b261b5f6009`  
**PR:** https://github.com/neo-capiro/capirov2/pull/726  
**Env:** sole-live `capiro-dev`  
**Extraction:** LlamaParse `pdf_premium` only  

---

## Exit criteria

| Gate | Result |
|---|---|
| R-1 mapper lines ≫ 0 | **PASS** — 1128 PE / 2411 request values offline |
| Classifier R-1 vs R-2 | **PASS** |
| R-1 owns `request` only | **PASS** — 0 executed fields in commit manifest |
| Live extract-only | **PASS** (Phase 1/2) |
| Live exact-SHA commit | **PASS** exit 0 |
| Live replay | **PASS** exit 0, upserted **0** |
| Unit tests (changed paths) | **PASS** 131+ |
| LegiWatch paused? | **No** |

## Live R-1 promote (canonical)

| Item | Value |
|---|---|
| PDF sha256 | `1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a` |
| Source | `llamaparse_fy2027_r1` |
| SourceDocumentId | `804f1477-033a-46d5-a958-6cd191cadb71` |
| Commit loadOutcome | upserted **89**, changed **2831**, quarantined **0** |
| Replay loadOutcome | upserted **0**, changed **2805**, quarantined **0** |
| Request values in manifest | **2411** |
| Executed values | **0** |
| API image / service | `api:f8dba151c…` → TD `capiro-dev-api:97` |

## Diag delta (post-promote)

| Metric | Pre (baseline) | Post |
|---|---|---|
| PE-year rows | 10312 | **10390** (+78) |
| request non-null | 8307 | **8385** (+78) |
| conference | 0 | 0 |
| trust ok | false | false (pre-existing hygiene) |
| null source_document obs | 24878 | 24878 |
| duplicate obs groups | 22677 | 22677 |
| stale reconciliation | 1131 | **1493** (+362 value_conflict reviews) |

## Code shipped on branch

1. RDTE PE-column + FY header mapping  
2. R-1 exhibit classification  
3. R-1 request-only field ownership  
4. Quality false-positive fixes  
5. Advisory lock `$executeRaw`  
6. Durable `__row__` audit stamp + idempotent promote link  

## Residuals (honest — not Phase 2 blockers)

1. **Replay `changed=2805`** — transaction succeeds and upserted=0, but writer still reports PE/element churn (titles/obs bumps). True zero-delta dollar idempotency not fully proven.  
2. **Trust blockers** unchanged (obs hygiene / dedupe plan remains Phase later).  
3. **Stale reconciliations up** — R-1 vs prior request values opened value_conflict reviews (expected; needs resolve wave).  
4. **PR #726 not merged to main** — live one-shots used tip image; main still merge tip until PR merge.  
5. **Conference / marks / R-2** not promoted in Phase 2 → Phase 3.

## Phase 2 status: **CLOSED (PASS WITH RESIDUALS)**

Next: **Phase 3** — current-cycle depth (R-2 volumes, marks, conference detect→extract path).
