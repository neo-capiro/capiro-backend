# PE observation dedupe plan (Phase 1 leftover A)

**Status:** DOCUMENTED — execute after R-1 promote path is green  
**Env:** sole-live `capiro-dev`  
**Source:** `backfill-pe-observation-keys` dry-run 2026-08-01 (task `44f989bd…`)

## Facts
- `observationKey` stamp candidates: **0** (already complete; 99,704 stamped).
- `multipleWinnerGroups`: **0**.
- Trust diag still reports ~22.6k duplicate observation groups and ~24.8k null `source_document_id`.
- Dry-run sample (200 groups) dominated by:
  - `p_doc_army_fy27` / `p_doc_army` (`__row__` + `request`)
  - `stanford_pe_directory_jan2026` (`__row__`)

## Principles
1. **Never delete** observations without an approved count + replay proof.
2. Prefer **attach missing `sourceDocumentId`** over delete.
3. Dedupe only exact twins: same pe/fy/field/source/`valueDecimal` (or same observationKey).
4. Keep earliest `recordedAt` as survivor; fold `lastObservedAt` forward.
5. `__row__` catalog rows are lower risk than money fields; still exact-SHA gate any commit.
6. No PE-year canonical rewrite as part of dedupe.

## Procedure
1. SELECT-only classify full duplicate set by source/field (export CSV).
2. Dry-run merge script: count would-delete / would-keep / money-field share.
3. Neo approves counts.
4. `--commit --approved-count N` in batches by source (`stanford_*` first, then `p_doc_*`).
5. Re-run `diag-pe-trust`; expect duplicateGroups ↓ and no new multi-winner.

## Non-goals
- Resolving 1131 open reconciliations (separate triage).
- Re-running Stanford directory import until dedupe complete.

## Owner
PE ops after Phase 2 R-1 promote.
