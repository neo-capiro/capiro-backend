# FY2026 Defense Appropriations — conference/enacted PE-value ingest (G5 / D5)

**Status:** ingestion PATH is fully built + proven; the extraction artifacts
are the remaining OFFLINE step. This runbook is the exact procedure. Enacted
dollars are the single most sensitive field in the system — never hand-key or
LLM-guess them; they come only from the committed pdfplumber artifacts,
inspected via dry-run diff before commit.

## What's already done
- FY26 **authorization** track is loaded: `armed_services_hasc_fy2026.json`,
  `armed_services_sasc_fy2026.json`, `ndaa_conference_fy2026.json` are
  committed under `apps/api/scripts/__data__/` and load `hascMark`/`sascMark`/
  `ndaaConference`.
- The mark-impact next-actions engine (this PR) consumes whatever
  conference/enacted values exist — it needs no further code to light up once
  the appropriations values land.

## What's missing (the offline extraction)
The FY26 **appropriations** track — `hacDMark`, `sacDMark`, `enacted` — has no
committed artifacts yet. Loaders exist and are proven on FY27:
- `parse:hac-d-report` / `parse:sac-d-report` → `hacDMark` / `sacDMark`
- `parse:defense-approps-public-law` → `enacted` (dry-run by default)

## Verified sources (2026-07-12 web recon)
FY26 DoD appropriations were enacted **Feb 3 2026** as Division A of the
Consolidated Appropriations Act, 2026 (H.R. 7148, **P.L. 119-75**). There is
no formal conference report; the PE-level tables live in the **explanatory
statement** printed in the Congressional Record, given conference-JES legal
effect by §4 of the act.

| Value | Document | URL |
|---|---|---|
| `enacted` (Div A DoD) | PLAW-119publ75 | https://www.govinfo.gov/content/pkg/PLAW-119publ75/pdf/PLAW-119publ75.pdf (1.6 MB — but the act carries only account-level lumps; PE tables are in the JES below) |
| **PE tables** (enacted detail) | Explanatory statement, CREC 2026-01-22 Book 2, pp. H1353–H1909 | https://www.govinfo.gov/content/pkg/CREC-2026-01-22/pdf/CREC-2026-01-22-pt2-PgH1353-2.pdf (>10 MB) — Division A = Defense |
| `hacDMark` | H. Rept. 119-162 (HAC-D, to accompany H.R. 4016) | https://www.govinfo.gov/content/pkg/CRPT-119hrpt162/pdf/CRPT-119hrpt162.pdf (6.6 MB) |
| `sacDMark` | S. Rept. 119-52 (SAC-D, to accompany S. 2572) | https://www.govinfo.gov/content/pkg/CRPT-119srpt52/pdf/CRPT-119srpt52.pdf (747 KB) |

(NDAA authorization conference, already loaded: P.L. 119-60, signed Dec 18
2025; JES in CREC 2025-12-10.)

## Procedure (offline, human-supervised)
For each of HAC-D, SAC-D, and the enacted JES:

1. Download the PDF above into the pdfplumber workspace (the same offline
   toolchain that produced every other budget artifact).
2. Run the committee-agnostic extractor:
   `python apps/api/scripts/__tools__/extract_armed_services_report.py`
   pointed at the PDF, producing a rows JSON:
   `{ chamber, fy: 2026, source, rows: ExtractedReportRow[] }`.
   Commit it as `apps/api/scripts/__data__/defense_approps_hac_d_fy2026.json`
   / `..._sac_d_fy2026.json` / `defense_public_law_fy2026.json`.
   Reconcile row/account totals against the document (blueprint §8.5 — table-
   level reconciliation, not visual plausibility).
3. Load, **dry-run first** (prints a `diffMarks` of the artifact vs current
   values, writes nothing):
   - `pnpm --filter @capiro/api parse:hac-d-report -- --artifact scripts/__data__/defense_approps_hac_d_fy2026.json`
   - `pnpm --filter @capiro/api parse:sac-d-report -- --artifact scripts/__data__/defense_approps_sac_d_fy2026.json`
   - `pnpm --filter @capiro/api parse:defense-approps-public-law -- --artifact scripts/__data__/defense_public_law_fy2026.json`
   Inspect each diff.
4. Re-run each with `--commit`. Each registers a checksummed `SourceDocument`
   and emits `IntelligenceChange` on every changed PE (feeds PE-Watch alerts).
5. Re-run the derive DAG so deltas + the mark-impact cards refresh:
   `pnpm --filter @capiro/api run-pe-derive-chain -- --commit`
   (as of G5, `generate-actions` is a step in this chain — the enacted-below-
   request / HAC-D-cut deltas become `add_report_language` next-action cards
   automatically).

## The reserved `conference` column
`ProgramElementYear.conference` (appropriations-conference rung) stays NULL —
FY26 had no separate appropriations conference report (the JES IS the enacted
detail, loaded as `enacted`). If a future cycle produces a distinct
appropriations conference document, add a loader writing `conference`; the
delta engine's `conference_vs_marks` + the mark-impact `add_report_language`
routing then light up with no further change.
