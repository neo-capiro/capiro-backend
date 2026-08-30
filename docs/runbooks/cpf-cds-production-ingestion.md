# CPF/CDS Production Ingestion & Advocacy Canary Runbook

Status target after engineering closeout:
`READY_FOR_PRODUCTION_INGESTION_AUTHORIZATION`

Do **not** execute production bulk ingest, Fill-with-Meri against real clients,
or the final Advocacy canary until separately authorized.

Repository: `neo-capiro/capirov2`
Module: `apps/api/src/government-data/community-funding/`
Campaign: `apps/api/scripts/run-cpf-cds-campaign.ts`

---

## Prerequisites

- API image / worktree at or after merge of:
  - #1328 CPF/CDS canonical identity
  - #1345 CPF/CDS advocacy discovery
  - #1349 CPF/CDS appropriations outcome correlation
  - source-coverage PR (`agent/advocacy-history-cpf-cds-source-coverage`)
- `DATABASE_URL` pointing at the **intended** target (disposable → staging → prod only with auth)
- Python with `pymupdf` for PDF extraction
- Network egress to:
  - `appropriations.house.gov`
  - `www.appropriations.senate.gov`

```bash
python -c "import pymupdf; print(pymupdf.__version__)"
```

---

## A. House historical backfill (bounded by FY)

```bash
# Dry-run first (discover + download + extract, no upsert)
pnpm --filter @capiro/api ingest:cpf-cds:campaign -- \
  --chamber house --fy 2026 --dry-run \
  --work-dir ./.cache/cpf-cds-house-fy2026 \
  --report ./.cache/cpf-cds-house-fy2026/report.json

# Real upsert into the DB pointed at by DATABASE_URL
pnpm --filter @capiro/api ingest:cpf-cds:campaign -- \
  --chamber house --fy 2026 \
  --work-dir ./.cache/cpf-cds-house-fy2026 \
  --report ./.cache/cpf-cds-house-fy2026/report-ingest.json
```

Repeat per FY: `2024`, `2025`, `2026`, `2027` (and `2022`/`2023` only if discovery accepts table docs).

Single-document fallback:

```bash
python apps/api/scripts/__tools__/extract_cpf_cds_pdf.py --profile auto table.pdf rows.json
pnpm --filter @capiro/api ingest:cpf-cds -- \
  --chamber house --fy 2026 \
  --artifact rows.json --source-file table.pdf \
  --source-url '<official-url>' \
  --source-key house_fy2026_<subcommittee_or_consolidated> \
  --subcommittee CJS
```

---

## B. Senate historical backfill (bounded by FY / subcommittee)

```bash
pnpm --filter @capiro/api ingest:cpf-cds:campaign -- \
  --chamber senate --fy 2026 --dry-run \
  --work-dir ./.cache/cpf-cds-senate-fy2026 \
  --report ./.cache/cpf-cds-senate-fy2026/report.json

pnpm --filter @capiro/api ingest:cpf-cds:campaign -- \
  --chamber senate --fy 2026 \
  --work-dir ./.cache/cpf-cds-senate-fy2026 \
  --report ./.cache/cpf-cds-senate-fy2026/report-ingest.json
```

Notes:
- FY2022–FY2023 links are often `/download/<slug>`; the campaign resolves `&download=1`.
- Some FY22/FY24 multi-origination joint tables may extract 0 rows — treat as parser gap, do not force-fabricate.

---

## C. Verification (read-only)

```sql
-- Canonical vs provenance
SELECT chamber, request_type, fiscal_year,
       COUNT(*) AS canonical
FROM community_funding_request
GROUP BY 1,2,3
ORDER BY 1,3;

SELECT COUNT(*) AS provenance FROM community_funding_request_source;

-- Ingest runs
SELECT chamber, fiscal_year, status, COUNT(*) AS runs,
       SUM(rows_emitted) AS rows_emitted,
       SUM(rejected) AS rejected
FROM community_funding_ingest_run
GROUP BY 1,2,3
ORDER BY 1,2;

-- Discovery crawls
SELECT adapter_id, status, COUNT(*) FROM community_funding_discovery_crawl GROUP BY 1,2;
```

Expect:
- provenance ≥ canonical
- rejected rows explained in `notes` JSON (no silent zero)
- rerun of same SHA → `skipped: unchanged artifact`

---

## D. Rerun / idempotency

```bash
# Second pass must skip unchanged SHAs
pnpm --filter @capiro/api ingest:cpf-cds:campaign -- --chamber house --fy 2026

# Force re-parse/re-upsert after parser fix
pnpm --filter @capiro/api ingest:cpf-cds:campaign -- --chamber house --fy 2026 --force
```

There is **no** “delete all CPF/CDS and retry” procedure. Corrections update
non-identity fields under the same `identity_hash`; new publications add
provenance rows.

---

## E. Incremental refresh

```bash
# Nightly-style: all known years, skip unchanged
pnpm --filter @capiro/api ingest:cpf-cds:campaign -- --all-years \
  --work-dir ./.cache/cpf-cds-incremental \
  --report ./.cache/cpf-cds-incremental/report.json
```

Wire the same command to the existing job runner (ECS one-shot / cron). Do not
invent a new scheduler. Checkpoint = `community_funding_ingest_run` by
`(source, artifact_sha256)`.

---

## F. Stop / rollback

- Stop: cancel the campaign process; partial runs leave committed upserts + run rows.
- Do not DELETE canonical rows to “undo”.
- If a bad parser profile polluted data: ship a parser fix, `--force` re-ingest
  the affected `source_key`s; identity/precedence rules correct non-identity fields.
- If a non-table PDF was accepted: mark discovery candidate rejected in a follow-up
  filter PR; do not bulk-delete.

---

## G. Final Advocacy production canary (DO NOT RUN until authorized)

After production canonical tables are populated and code is deployed:

1. Pick one internal QA client with a known real CPF/CDS recipient match.
2. Run Fill with Meri advocacy_history / lifecycle_outcomes only for that client.
3. Prove:

```text
canonical CPF/CDS request
→ recipient match (confirmed|exact|alias|fuzzy+geo)
→ pending Fill finding (one per request)
→ multi-doc provenance attached
→ human accept/reject
→ Advocacy record
→ Matter
→ deterministic later outcome if qualifying evidence exists
   (request id or account+FY; causationClaimed:false)
```

4. Verify source health shows `community_funding` with real counts, not “0 = complete”.
5. Only then consider `ADVOCACY_HISTORY_COMPLETE`.

---

## H. Outcome-correlation invariants (already in #1349)

- Tier1: same `community_funding_request` id
- Tier2: exact appropriations account + exact FY
- Fail closed: account-only, FY-only, title similarity, disagreeing request ids,
  outcome not strictly after activity
- Always `causationClaimed:false`
