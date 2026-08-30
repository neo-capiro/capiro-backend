# Canonical CPF/CDS ingestion

This module stores global, public-domain House Community Project Funding (CPF)
and Senate Congressionally Directed Spending (CDS) rows. It has no tenant key,
RLS policy, client linkage, or advocacy-table write path.

## Identity and update policy

`identityHash` is the canonical-JSON SHA-256 over:

- chamber + requestType
- fiscal year
- `requesterIdentityToken(requesterName)` (cross-format-stable primary surname)
- normalized recipient name
- normalized project title

`sourceDocumentId` is **not** part of identity. One real funding request maps to
one `community_funding_request` even when it appears in a subcommittee PDF and a
consolidated XLSX; each publication is a separate
`community_funding_request_source` provenance row.

Senate's `Recommendation ($)` is stored in `requestedAmountUsd` because that is
the canonical pre-final amount column, but `amountStageRaw` is explicitly
`senate_recommendation`; it is never represented as a raw member ask. The
nullable `finalAmountUsd` is populated only from a source that explicitly
distinguishes a later funded/enacted stage.

## Offline extraction and verified coverage

PDF extraction is offline via `scripts/__tools__/extract_cpf_cds_pdf.py`, using
pymupdf positioned words (not pdfplumber — rotated tables). NestJS only parses
the resulting JSON rows. Profiles:

| Profile | Layout | When |
|---|---|---|
| `house` | Agency, Account, Recipient, Project, Location, Amount, Requestor | CJS-style recipient-first (FY2026 CJS fixture, FY2027 tables) |
| `house_location` | Agency, Account, Location, Recipient, Project, Amount, Requestor (normalized to house column order) | House posted tables with location-before-recipient (FY2024–FY2026 AG-style) |
| `senate` | Account, State, Project, Recipient, Amount, Requestor | Senate CDS recommendation tables |
| `auto` | scores the three by valid rows × structural quality | campaign runner default |

House XLSX is read directly with ExcelJS. Headers accept FY aliases
(`Project Purpose` ≡ `Project Description`).

Discovery adapters know the authoritative FY2022–FY2027 index pages for both
chambers. They:

- accept Senate `/download/<slug>` CMS links (resolve `&download=1` interstitial)
- reject House Jurisdictions/Rules/guidance PDFs
- accept posted/updated/final/consolidated tables and XLSX

### Fixture-verified parse coverage (unit/real-document specs)

- House FY2026 CJS PDF: 66 pages, 937 extracted/parsed, 0 rejected (`house`)
- Senate FY2026 Agriculture PDF: 11 pages, 233 extracted/parsed, 0 rejected (`senate`)
- House FY2026 consolidated XLSX: 5,414 data rows, 5,363 parsed, 51 rejected
  (blank required Recipient cells — retained in rejection counts)

### Live discovery snapshot (engineering rehearsal)

Index pages HTTP 200 for House+Senate FY2022–FY2027. Accepted table candidates
vary by year (House FY24–27 rich; Senate FY22–23 via `/download/`; Senate FY27
currently guidance-only). Some older multi-column joint CPF/CDS landscape
tables (e.g. certain FY22/FY24 Senate AG multi-origination layouts) still return
0 rows under the three profiles — they are recorded as parser gaps, not silent
success.

## Commands

Single document (existing):

```bash
python apps/api/scripts/__tools__/extract_cpf_cds_pdf.py --profile auto table.pdf rows.json
pnpm --filter @capiro/api ingest:cpf-cds -- \
  --chamber house --fy 2026 \
  --artifact rows.json --source-file table.pdf \
  --source-url <official-url> --source-key cpf_house_fy2026_cjs \
  --subcommittee CJS
```

Discovery only:

```bash
pnpm --filter @capiro/api ingest:cpf-cds -- --chamber senate --fy 2026 --discover
```

Campaign runner (discover → download → extract → optional upsert):

```bash
# dry-run (no canonical upserts)
pnpm --filter @capiro/api ingest:cpf-cds:campaign -- --all-years --dry-run --report ./cpf-report.json

# bounded real ingest into the DATABASE_URL you point at (disposable/staging only
# unless separately authorized)
pnpm --filter @capiro/api ingest:cpf-cds:campaign -- --fy 2026 --chamber house
```

Unchanged successful artifacts are checkpointed via
`community_funding_ingest_run.artifact_sha256` and skipped unless `--force`.

## Production safety

Do not bulk-ingest into production, run Fill with Meri against real clients, or
mark `ADVOCACY_HISTORY_COMPLETE` from this module alone. Canonical government
data is append/update controlled — there is no “delete everything and retry”
path.
