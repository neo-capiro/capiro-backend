# PE Watch LlamaParse Ingestion — Execution Handoff

Worktree: `C:\Users\neoma\capiro-pe-wt` (detached, off origin/main).
Secret env (gitignored, NOT committed): `C:\Users\neoma\.capiro-pe-secrets.env`.

## Status: core pipeline COMPLETE and live-verified

- 61 unit tests / 11 suites passing; whole `src/defense-budget/` + script typecheck clean.
- Live dry-runs (real S3 + real LlamaParse, new key):
  - RDT&E Vol 1 (153 pp): archived immutably (Object Lock GOVERNANCE→2033, SSE-KMS, VersionId), 60 PE lines / 43 values, PE 0601601A FY25=9.933M FY26=17.012M ground-truth-verified. Rerun deduped (idempotent).
  - Missile Procurement Army: archived, 693 BLIN lines / 697 values, 0 warnings.
- Additive migration written + verified non-destructive: `prisma/migrations/20260714205910_pe_watch_s3_archive_and_parse_job/`.

## BLOCKED from this workstation (need ECS / DB access)

Dev Aurora `capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv` is in a private subnet; no local DATABASE_URL. Migrations + DB-writing ingestion run via the ECS one-off task, not the workstation.

### Step A — apply the additive migration (via ECS `migrate` task, dev)
The migration only ADDs 6 nullable columns to `source_document` + a new `document_parse_job` table + indexes/FK. No destructive DDL. Deploy the branch image and run the existing `migrate` entrypoint verb (same path used for every prior PE Watch migration).

### Step B — batch ingestion (ECS one-off, dev; TMPDIR=/dev/shm)
Command (verb wired in entrypoint.sh):
```
ingest-defense-budget --path "<mounted corpus dir>" --fy 2027
```
Or scoped first run to validate the DB-write path before spending full credits:
```
ingest-defense-budget --path "<dir>" --fy 2027 --only rdte --limit 5
```
Notes:
- Idempotent: SHA-addressed archive dedups byte-identical copies (the " (1)" duplicates) and DocumentParseJob dedups reruns.
- Real LlamaParse credits are spent per NEW document. Dry-runs so far showed cache hits (0 credits) for already-parsed SHAs.
- `--dry-run` archives + parses but skips all DB writes (safe anywhere with S3 + LlamaParse creds).

### Step C — read-only verification (ECS SELECT-only verbs)
`report-pe-coverage --fy 2027 --json`, `diag-pe-detail-coverage`, `diag-ingestion-health`,
`diag-blin-coverage`, `diag-graph-coverage`, `diag-pe --pe=0601601A`.
Then fill the success-criteria actuals in the plan and declare MET/UNMET.

## Local corpus
`C:\Users\neoma\Downloads\New folder (2)\` — ~100 FY2027 J-books (RDTE/procurement/O&M),
committee reports (CRPT-*), public law (PLAW-119publ75), NDAA marks, JES.
Non-budget artifacts (org charts, overviews, milpers) are auto-skipped by the classifier.

## New/changed files (change set)
- `prisma/schema.prisma` (+migration), `src/config/config.schema.ts`,
  `src/program-element/source-document/source-document-registry.ts` (archive cols),
  `package.json`, `scripts/entrypoint.sh` (ingest-defense-budget verb),
  `scripts/ingest-defense-budget-pdf.ts`,
  `src/defense-budget/` (13 modules + specs).
