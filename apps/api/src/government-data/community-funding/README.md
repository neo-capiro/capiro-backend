# Canonical CPF/CDS ingestion

This module stores global, public-domain House Community Project Funding (CPF)
and Senate Congressionally Directed Spending (CDS) rows. It has no tenant key,
RLS policy, client linkage, or advocacy-table write path.

## Identity and update policy

`identityHash` is the existing canonical-JSON SHA-256 over chamber, request
type, fiscal year, normalized requester, recipient and project title, normalized
raw appropriations account, and SourceDocument ID. A replay of the same source
row is a no-op. A correction to a non-identity field under that identity updates
the row and `sourceHash`; a changed identity field or a new SourceDocument
version creates a distinct row. This deliberately preserves source-version
provenance and never uses title alone.

Senate's `Recommendation ($)` is stored in `requestedAmountUsd` because that is
the canonical pre-final amount column, but `amountStageRaw` is explicitly
`senate_recommendation`; it is never represented as a raw member ask. The
nullable `finalAmountUsd` is populated only from a source that explicitly
distinguishes a later funded/enacted stage. It is null for all FY2026 sources in
this rehearsal.

## Offline extraction and verified coverage

PDF extraction is offline via `scripts/__tools__/extract_cpf_cds_pdf.py`, using
pymupdf positioned words. NestJS only parses the resulting JSON rows. House
XLSX is read directly with the existing ExcelJS dependency.

The discovery adapters know the authoritative FY2022-FY2027 index pages for
both chambers and scrape their document links on each run; they do not hardcode
subcommittee names. Working parse coverage verified in this change is narrower:

- House FY2026 CJS PDF: 66 pages, 937 expected/extracted/parsed, 0 rejected.
- Senate FY2026 Agriculture PDF: 11 pages, 233 expected/extracted/parsed, 0 rejected.
- House FY2026 consolidated XLSX (`asRequestedCPFs_FY26`): 5,414 data rows
  beneath one header, 5,363 parsed, 51 rejected because the official rows have
  blank required `Recipient` cells (the first is workbook row 129). They are
  retained in checkpoint rejection counts rather than silently fabricated.

The first five rows of each PDF were manually compared with pymupdf's natural
raw text, and the first five XLSX data rows were compared with their cells.
Their recipient, project, amount and requestor values are asserted in the
real-document spec. No parse coverage beyond those exact sources is claimed.

## Commands

Generate a PDF artifact with the Hermes Python interpreter, then load it with
`pnpm ingest:cpf-cds -- --chamber house --fy 2026 --artifact <rows.json>
--source-file <table.pdf> --source-url <official-url> --source-key
cpf_house_fy2026_cjs --subcommittee CJS`. Use `--discover` with chamber/FY to
persist a discovery crawl. Unchanged successful artifacts are checkpointed and
skipped unless `--force` is supplied.
