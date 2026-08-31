# Advocacy History CPF/CDS — Final Gate Report

**Date:** 2026-08-31  
**Repo:** neo-capiro/capirov2  
**Worktree:** `C:\dev\cpf-cov` @ `bb6c9cc81` (+ uncommitted ops fixes)  
**Disposable DB:** `cpf-cds-disposable` on host port **54329** (55432 blocked by Windows excluded range)

---

## Gate decision

```
READY_FOR_PRODUCTION_INGESTION_AUTHORIZATION
```

**Meaning:** Engineering + disposable full-corpus validation are complete enough to
**request separate human authorization** for production ingestion. This is **not**
`ADVOCACY_HISTORY_COMPLETE`, and **no production system was mutated**.

**Authorization shape (recommended):**
1. House-first FY-bounded backfill (FY2024–FY2027)
2. Senate non-zero subcommittee tables (esp. FY2025–FY2026)
3. Hold Senate joint/LHHS zero-row layouts until a clean profile exists
4. Advocacy canary only after prod tables + verification SQL

---

## PR / code status

| PR | What | State |
|---|---|---|
| #1328 | Canonical identity + provenance | MERGED |
| #1345 | Advocacy discovery | MERGED |
| #1349 | Deterministic outcome correlation | MERGED (`d6ebdbdb6`) |
| #1357 | Source coverage, campaign runner, runbook | MERGED (`74bf7132f`; head `bb6c9cc81`) |

### Uncommitted ops fixes still in worktree (should ship as follow-up PR)

- `run-cpf-cds-campaign.ts`: sourceKey URL-hash disambiguator; Windows extractor retry; **`--from-cache`**
- `extract_cpf_cds_pdf.py`: investigative `senate_joint` (not wired to auto)
- `community-funding.senate-joint.spec.ts` + real PDF fixture
- `bulk_extract_cpf_cds_cache.py`: single-process offline extract (avoids DLL flake)
- `cpf_cds_corpus_audits.py`, match QA sample helpers
- Runbook updates (Windows notes, `--from-cache`, gap ledger, auth shape)

---

## Phase results (9–24)

### Phase 9 — Corpus result tables (PASS)

| Metric | Value |
|---|---|
| Canonical requests | **29,728** |
| Provenance rows | **39,042** |
| Ingest runs | 153 |
| Source documents | 153 |
| Cross-doc collapse estimate | 9,314 |
| Multi-provenance requests | 9,227 (max 7) |
| Restore campaign | 153 ingested / **0 failed** / 13 non-table / 39,042 parsed / 10,882 rejected |

**By chamber × FY**

| Chamber | FY | Canonical |
|---|---|---|
| house | 2024 | 8,502 |
| house | 2025 | 6,049 |
| house | 2026 | 8,433 |
| house | 2027 | 4,919 |
| senate | 2022 | 293 |
| senate | 2023 | 428 |
| senate | 2024 | 320 |
| senate | 2025 | 353 |
| senate | 2026 | 431 |

House FY22/FY23: 0 (index has no tables after juris/rules filter). Senate FY27: 0 (guidance only).

### Phase 10 — Identity collision audit (PASS with notes)

- `identity_hash` collisions: **0** (unique constraint + live count 29728 = 29728 distinct)
- Near-dup groups (same recipient+project+FY+chamber, different requesters): multi-member requests — **correct by design** (requester is in identity)
- Bad recipients: **3** single-letter (`E`, `S`) house_location parse noise — fail closed for match; do not treat as blockers
- Manual samples: 25 inspected (near-dup multi-member + multi-provenance)

### Phase 11 — Provenance audit (PASS)

- Requests without provenance: **0**
- Orphan provenance: **0**
- Avg sources/request: 1.31; median 1; max 7

### Phase 12 — Amount/stage audit (PASS)

| Stage | Count |
|---|---|
| amount_requested | 14,716 |
| house_amount | 13,187 |
| senate_recommendation | 1,825 |

- Negative amounts: **0**
- Unknown stages: **0**
- Note: `final_amount_usd` not populated on this corpus (stage labels are requested/house/senate_rec only) — expected for request-side tables; do not conflate with enacted

### Phase 13 — Idempotency (PASS)

| Run | Result |
|---|---|
| Full `--all-years --from-cache` (no force) | **153 skipped_unchanged**, Δ req=0, Δ src=0, Δ run=0 |
| `--force --from-cache --chamber house --fy 2026` | 13 re-ingested, **Δ canonical = 0** |

### Phase 14 — Incremental refresh (PASS)

Same path as nightly `--all-years` without `--force`: skips unchanged SHAs via `community_funding_ingest_run (source, artifact_sha256)`. Proven by Phase 13a.

### Phases 15–18 — Multi-client Advocacy / lifecycle / Matter (PASS at pure-module + unit level)

- Focused unit gates: **4 suites / 29 tests PASS**
  - `community-funding-appropriations-outcome.spec.ts`
  - `community-funding-advocacy-match.spec.ts`
  - `client-profile-fill-finding-source-check.contract.spec.ts`
  - `community-funding.senate-joint.spec.ts`
- Real-corpus samples pulled for exact/alias/fuzzy/no-match/multi-prov scenarios
- Match hierarchy unchanged: confirmed → exact → alias → fuzzy+geo → fail closed
- One finding per request id (multi-doc provenance does not multiply)
- **Not run:** live Fill-with-Meri / Matter write on real clients (requires separate auth + client rows in disposable)

### Phases 19–20 — Outcome correlation + source health (PASS)

- Outcome unit invariants green (request-id, disagreeing ids, account+FY, temporal ordering, `causationClaimed:false`)
- Account field populated on **47.4%** of canonical rows (tier-2 outcome only when both account+FY present)
- Source health: 61 docs with rows / 92 docs ingested with 0 parsed rows (documented gaps, not silent success)

### Phase 21 — Senate gap production decision

| Class | Decision |
|---|---|
| Senate joint “Amount Provided” multi-origination | **BLOCKED for auto-ingest** — investigative `senate_joint` only; not wired to auto |
| Senate LHHS-style (no recipient/state) | **BLOCKED for auto-ingest** until dedicated clean profile |
| Senate tables that already extract under `senate` | **ALLOWED** (included in FY25–26 non-zero set) |
| House consolidated XLSX + recipient-first / location-first PDFs | **ALLOWED** |

### Phase 22 — Runbook

Updated: `docs/runbooks/cpf-cds-production-ingestion.md`  
Adds Windows notes, `--from-cache`, bulk extract, gap ledger, House-first auth shape.

### Phase 23 — Canary plan (prepared, not executed)

Per runbook §G — do not run until production tables exist and human authorization is granted:
1. One internal QA client with known CPF/CDS recipient
2. Fill advocacy_history only
3. Prove request → finding → accept → record → Matter → outcome
4. Source health non-zero for `community_funding`

### Phase 24 — This report

---

## Bugs found and fixed during this mission

1. **sourceKey title collision** — generic titles overwrote distinct docDirs → URL hash suffix
2. **`PYTHON` MSYS path** — broke native spawnSync → use bare python
3. **Jest corpus wipe** — cross-source-dedup TRUNCATE after campaign → document; restore via force
4. **Checkpoint without rows** — ingest_run survived partial wipe → false skipped_unchanged → always truncate ingest_run when resetting disposable
5. **Windows STATUS_DLL_INIT_FAILED** — rapid pymupdf spawns → retry + bulk extract + `--from-cache`
6. **Port 55432 excluded** — Hyper-V range → disposable on 54329
7. **Auto profile chamber bleed** — house docs picking senate / senate picking house_location → chamber-aware bulk extract

---

## Production safety checklist (still required)

- [ ] Human authorizes production `DATABASE_URL` target
- [ ] House FY-bounded backfill (runbook A) with dry-run first
- [ ] Verification SQL (runbook C) on prod
- [ ] Idempotent rerun proof on prod
- [ ] Separate auth for Advocacy canary (runbook G)
- [ ] Do **not** mark `ADVOCACY_HISTORY_COMPLETE` from this report alone

---

## Artifacts

| Path | What |
|---|---|
| `C:\dev\cpf-cov\apps\api\.cache\cpf-cds-campaign3\report-restore.json` | Full restore totals |
| `...\report-idempotent.json` | Skip-unchanged proof |
| `...\report-force-h26.json` | Force House FY26 proof |
| `/tmp/cpf-cds-p9-12-audit.json` | Phases 9–12 audit JSON |
| `/tmp/cpf-source-health.json` | Source health + gap ledger |
| `/tmp/cpf-qa-samples.json` | Real-corpus match samples |
| `docs/runbooks/cpf-cds-production-ingestion.md` | Updated runbook |

---

## Next engineering action (optional, not gate-blocking)

Open follow-up PR from uncommitted `cpf-cov` worktree with:
- `--from-cache` + sourceKey fix + extractor retry
- bulk extract tool
- senate_joint investigative profile + spec (still not auto)
- runbook updates

Then request production ingestion authorization for **House-first** backfill.
