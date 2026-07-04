# Program Elements / Budget Lines — data-ops backlog

Runbook for the remaining Program Elements gaps that are **data acquisition + prod
execution**, not code. As of 2026-07-04 the code for all five items below is
complete on the branch; what's left is running extractions against real PDFs and
executing jobs/backfills against the prod DB. Do these from a prod-capable
environment (an ECS one-off task or a machine with prod DB access + the sync API
keys), not a local worktree.

Related runbooks: `procurement-p40-ingestion.md`, `defense-budget-intelligence-deploy-and-remaining.md`.
Progress tracker: `docs/plans/PROGRESS-defense-budget-intelligence.md`.

---

## 1. P-1 procurement ingestion (code DONE — needs PDFs)

**Status.** The old blocker (the P-Doc loader validated codes with the RDT&E-only
`isValidPeCode`, quarantining every procurement BLIN) is **already fixed**:
`program-element-writer.service.ts` validates through `isValidProgramCode()`
(`isValidPeCode || isValidProcurementCode`), the `PROCUREMENT_CODE_REGEX`
(`/^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14}$/`) accepts BLINs like `9670A00005`,
`1506N0145`, `3010FB02100`, and the `ProgramElementProcurementLine` table +
`/program-elements/:peCode/procurement-lines` endpoint + delta engine all read it.
The "parked" note in PROGRESS line 26 is stale.

**What remains:** obtain the P-1 PDFs, extract, load. Per-service (Army aircraft,
missiles, WTCV, ammo; AF ammo book; Navy; DW) because each book is a separate PDF.

```bash
# 1) Extract a P-1 book to a JSON artifact (deterministic, pdfplumber).
python apps/api/scripts/__tools__/extract_pdoc.py <p1_pdf_path> > apps/api/scripts/__data__/pdoc_<service>_fy<YY>.json

# 2) Dry-run the loader — inspect parsed rows + quarantine count BEFORE writing.
tsx apps/api/scripts/parse-pdoc-army.ts --artifact apps/api/scripts/__data__/pdoc_<service>_fy<YY>.json

# 3) Commit.
tsx apps/api/scripts/parse-pdoc-army.ts --artifact <...> --commit

# 4) Optional: enrich P-40 detail fields (description, ACAT, program of record, status).
tsx apps/api/scripts/load-pdoc-enrichment.ts --artifact <...> --commit
```

**Verify:** rows land in `program_element` with `appropriationType='PROC'` and in
`program_element_procurement_line`; spot-check a line's qty + $ vs the PDF (the
FY2024 Army sample verified at $49,969K). Check the quarantine count is ~0 — any
quarantined rows print their reason (`SELECT reason, count(*) FROM
program_element_quarantine GROUP BY reason`).

**After loading:** re-run the derive DAG (see §6) so procurement lines get money-graph
edges + deltas.

**AF ammunition book:** same procedure once the PDF is obtained; no code change
needed. If a specific line fails to key, capture the code and confirm it against
`PROCUREMENT_CODE_REGEX` before widening (do NOT loosen the regex to admit non-codes).

---

## 2. FYDP outyears / prior-PB comparison (code DONE — needs extractor extension + PDFs)

**Status.** Schema (`ProgramElementBudgetPosition`), writer (`budget-position-writer.ts`),
comparison logic (`budget-position.ts` `computePbComparison`), the `pb_vs_prior_pb`
/ `outyear_shift` delta types, and the `/positions` + `/pb-comparison` endpoints are
all built and unit-tested. They return **empty** today because no rows are loaded.

**Two blockers, both data:**

**(a) The committed FY2027 R-1 artifact has no per-FY dollar columns.**
`extract_jbook_r1.py` captures trailing money tokens only *positionally* as
`raw_trailing_amounts` — it does NOT map a column to a fiscal year (that needs the
page's header row, which the current line-by-line pass doesn't read). The TS loader
(`buildPositionsFromFyColumns`) consumes a `fyColumns: {2027: $, 2028: $, ...}` map
that the artifact does not yet carry, so `sync-comptroller-jbooks` writes 0 positions.

Required code step (small, but must be validated against the real PDF layout — do it
where the FY2027 R-1 PDF is available):
- Extend `extract_jbook_r1.py` with a header-aware pass: read each page's column
  header row (PY / CY / BY1..BY5 / FYDP), map each `raw_trailing_amount` position to
  its `assertedFy`, and emit `fyColumns` per row. Keep the "no fabricated assertedFy"
  rule — if the header can't be read for a page, emit no `fyColumns` for its rows.
- Re-run against the FY2027 R-1 PDF (`https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_r1.pdf`)
  and commit the regenerated `apps/api/scripts/__data__/jbook_r1_fy2027.json`.

**(b) The FY2026 prior-PB R-1 book has not been located.**
`computePbComparison` returns `[]` with fewer than 2 PB cycles present. Acquire the
FY2026 PB R-1 (prefer a machine-readable XLSX from the DoD FM site if available;
else the PDF), extract it the same way, and load as `positionCycle='pb_fy2026'`.

```bash
# After the extractor extension + both artifacts exist:
tsx apps/api/scripts/sync-comptroller-jbooks.ts --commit    # writes positions when fyColumns present
tsx apps/api/scripts/compute-budget-deltas.ts --commit      # emits pb_vs_prior_pb + outyear_shift once 2 cycles exist
```

**Verify:** 5-PE spot-check that BY1..BY5 amounts match the R-1 PDF; ≥80% of PEs in
both books show sane `pb_vs_prior_pb` deltas; ≥3 examples each of `new_in_pb` /
`dropped_from_pb`. `/program-elements/:peCode/pb-comparison` returns non-empty.

---

## 3. SAM.gov opportunities historical backfill (code DONE this branch — needs a prod run)

**Status.** The daily job pulls only the last ~30 days. This branch adds backfill
support to `sync-sam-opportunities.ts`:
- `SAM_MAX_PAGES` env override for the page circuit-breaker (default 50 → 5,000 rows/run).
- `--posted-to YYYY-MM-DD` explicit window end.
- `--backfill` flag: bypasses the "already running" guard so a manual run isn't
  skipped by the daily cron, and does NOT touch the incremental watermark (the
  SyncRun `startedAt` is wall-clock now, so the daily floor is unaffected).
- A loud `⚠️ CAPPED` warning if a window's record count exceeds the page budget, so
  no gap goes silent (mirrors the Congress 5,000-cap fix).

**SAM.gov caps a single search's date span at ~1 year**, so walk the backfill in
≤1-year windows (newest-first is fine — upsert is idempotent on `noticeId`):

```bash
# Requires SAM_GOV_API_KEY in env. Dry-run first (omit --commit) to see counts.
SAM_MAX_PAGES=200 tsx apps/api/scripts/sync-sam-opportunities.ts --backfill --since 2024-07-01 --posted-to 2025-06-30 --commit
SAM_MAX_PAGES=200 tsx apps/api/scripts/sync-sam-opportunities.ts --backfill --since 2023-07-01 --posted-to 2024-06-30 --commit
SAM_MAX_PAGES=200 tsx apps/api/scripts/sync-sam-opportunities.ts --backfill --since 2022-07-01 --posted-to 2023-06-30 --commit
# ...continue back as far as desired.
```

If a window logs `⚠️ CAPPED`, split it (e.g. into quarters) or raise `SAM_MAX_PAGES`
and re-run that window — the run is idempotent.

**Verify:** `sam_opportunity` row count grows; archived notices present
(`SELECT active, count(*) FROM sam_opportunity GROUP BY active`); the daily job's
next incremental run is unaffected (its window still starts from the last daily
success, not the backfill).

---

## 4. DOCX export of fact-sheet artifacts (code DONE this branch — deploy only)

**Status.** Implemented on this branch:
- `apps/api/src/intelligence/artifacts/artifact-docx.ts` — renders the artifact
  `bodyText` markdown (title / `## Sources` / `## Caveats` / bullets / prose) to a
  branded Word doc via the `docx` lib, matching `alert-memo-docx.ts`.
- `GET /api/intelligence/artifacts/:id/export/docx` — tenant-scoped download.
- `ArtifactsPanel.tsx` — a "Download .docx" button in the artifact viewer drawer.

No data step. Ships with the next api + web deploy. Verify by generating an artifact
from any action card and clicking Download .docx.

---

## 5. Legacy PE codes (code DONE — verify only)

**Status.** The PE-code regex was already widened to
`/^[0-9]{7}[A-Z][A-Z0-9]*$/`, which accepts multi-char service/sub-element suffixes
(`0604122D8Z`, `1203622SF`, `0208085JCY`) that the old 8-char-only regex rejected.
Tests cover these. Invalid codes are dropped to `program_element_quarantine` (they
are not partially stored).

**Verify there's nothing still failing** — check the quarantine table on prod for
`Invalid pe_code` reasons:

```sql
SELECT reason, count(*) FROM program_element_quarantine
WHERE reason LIKE 'Invalid pe_code%' GROUP BY reason ORDER BY 2 DESC;
```

If real codes still appear there, capture the exact strings and decide per-pattern
whether the regex should widen further or whether they're genuinely malformed
(don't loosen the regex to admit non-codes). The `reconciliation_review_queue` is a
separate mechanism for cross-source *value* conflicts, not code-format failures.

---

## 6. Derive DAG — run AFTER any load above

The money-graph + deltas are derived, not ingested, so re-run these in order after
loading P-1 (§1), FYDP (§2), or any budget data. All are idempotent; dry-run by
default, `--commit` to persist.

```bash
tsx apps/api/scripts/derive-budget-actions.ts --commit        # 1) normalize marks -> add/cut/new_start/termination
tsx apps/api/scripts/derive-relationships.ts --commit         # 2) money-graph edges
tsx apps/api/scripts/derive-intelligence-cache.ts --commit    # 3) line type, maturity, appropriability (depends on 1+2)
tsx apps/api/scripts/compute-budget-deltas.ts --commit        # 4) materiality-scored deltas
```
